// Pure helpers for the panel-native Proton Authenticator integration.
// No Qt imports: QML loads this via `import "Model.js" as Model`, while Node's
// test runner exercises the same parsers and command builders.
//
// Security boundary: this plugin never reads Proton's IndexedDB, keyring,
// session, storage key, or TOTP seeds. It intentionally receives bounded
// generated codes from the private helper while the panel is open.

var MAX_HELPER_BYTES = 1024 * 1024;
var MAX_HELPER_ENTRIES = 200;
var MAX_TEXT = 160;
// A forged generation counter can never be caught up by a real helper, which
// would wedge the staleness comparison for the life of the session, so bound
// what a snapshot is allowed to claim.
var MAX_GENERATION = 2147483647;

function utf8ByteLength(value) {
  var s = String(value || "");
  var bytes = 0;
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length
             && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function truncateUtf8(value, maxBytes) {
  var s = String(value || "");
  var max = Math.max(0, Math.floor(Number(maxBytes) || 0));
  if (utf8ByteLength(s) <= max) return s;
  var suffix = max >= 3 ? "\u2026" : "";
  var budget = max - utf8ByteLength(suffix);
  var out = "";
  var used = 0;
  for (var i = 0; i < s.length;) {
    var code = s.charCodeAt(i);
    var units = 1;
    var size;
    if (code < 0x80) size = 1;
    else if (code < 0x800) size = 2;
    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length
             && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) {
      size = 4;
      units = 2;
    } else size = 3;
    if (used + size > budget) break;
    out += s.substr(i, units);
    used += size;
    i += units;
  }
  return out + suffix;
}

function sanitizeText(value, limit) {
  var s = String(value === undefined || value === null ? "" : value);
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  // Invisible, bidi, and filler code points that render as nothing or as blank
  // width, so two rows can otherwise display an identical issuer. Mirrors the
  // Rust-side bounded_text set: soft hyphen, bidi marks and isolates, invisible
  // operators, Hangul fillers, variation selectors, and Unicode tag characters.
  // `\s+` collapsing does not catch these — U+3164 and U+180E are not JS \s.
  s = s.replace(/[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "");
  s = s.replace(/[\u115F\u1160\u3164\uFFA0]/g, "");
  s = s.replace(/[\uFE00-\uFE0F]/g, "");
  s = s.replace(/\uDB40[\uDC00-\uDC7F]/g, "");
  s = s.replace(/\s+/g, " ").replace(/^ +| +$/g, "");
  var max = limit === undefined ? MAX_TEXT : Math.max(0, Number(limit) || 0);
  return truncateUtf8(s, max);
}


function safeHelperCode(value, type) {
  var code = String(value || "");
  if (type === "Steam") return /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/.test(code) ? code : "";
  return /^\d{6,10}$/.test(code) ? code : "";
}

function emptyHelperSnapshot(error) {
  return {
    ok: false,
    state: "unavailable",
    locked: false,
    synced: false,
    account: "",
    generation: 0,
    now: 0,
    entries: [],
    error: sanitizeText(error || "Helper unavailable", 160)
  };
}

function parseHelperSnapshot(text) {
  var raw = String(text || "");
  // The cap is UTF-8 bytes, matching the documented limit and the Python
  // client's own byte cap. raw.length counts UTF-16 units, which accepted a
  // 1.2 MB non-ASCII payload past a nominal 1 MiB limit.
  if (raw === "" || utf8ByteLength(raw) > MAX_HELPER_BYTES) return emptyHelperSnapshot("Invalid helper response");

  var data;
  try { data = JSON.parse(raw); } catch (e) { return emptyHelperSnapshot("Invalid helper response"); }
  if (!data || typeof data !== "object" || data.v !== 1 || data.ok !== true)
    return emptyHelperSnapshot(data && data.error ? data.error : "Helper unavailable");

  var allowedStates = { ready: true, locked: true, needs_login: true, unavailable: true, error: true };
  var state = String(data.state || "unavailable");
  if (!allowedStates[state]) state = "error";
  var now = Math.max(0, Math.floor(Number(data.now) || 0));
  var generation = clampGeneration(data.generation);
  var values = data.entries instanceof Array ? data.entries : [];
  var entries = [];

  for (var i = 0; i < values.length && entries.length < MAX_HELPER_ENTRIES; i++) {
    var value = values[i];
    if (!value || typeof value !== "object") continue;
    var id = String(value.id || "");
    var type = value.type === "Steam" ? "Steam" : (value.type === "Totp" ? "Totp" : "");
    var code = safeHelperCode(value.code, type);
    var nextCode = safeHelperCode(value.nextCode, type);
    var period = Math.floor(Number(value.period) || 0);
    var validUntil = Math.floor(Number(value.validUntil) || 0);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || type === "" || code === "" || nextCode === "") continue;
    if (period < 15 || period > 120 || validUntil < 0) continue;
    entries.push({
      id: id,
      name: sanitizeText(value.name || "Unnamed", 80),
      issuer: sanitizeText(value.issuer || "", 80),
      type: type,
      code: code,
      nextCode: nextCode,
      period: period,
      validUntil: validUntil
    });
  }

  return {
    ok: true,
    state: state,
    locked: data.locked === true,
    synced: data.synced === true,
    account: sanitizeText(data.account || "", 120),
    generation: generation,
    now: now,
    entries: entries,
    error: sanitizeText(data.error || "", 160)
  };
}

function filterEntries(entries, query) {
  var values = entries instanceof Array ? entries : [];
  var needle = sanitizeText(query || "", 80).toLowerCase();
  if (needle === "") return values.slice(0, MAX_HELPER_ENTRIES);
  var result = [];
  for (var i = 0; i < values.length && result.length < MAX_HELPER_ENTRIES; i++) {
    var row = values[i] || {};
    var haystack = (String(row.name || "") + " " + String(row.issuer || "")).toLowerCase();
    if (haystack.indexOf(needle) !== -1) result.push(row);
  }
  return result;
}

function clampGeneration(value) {
  var generation = Math.floor(Number(value) || 0);
  if (!isFinite(generation) || generation < 0) return 0;
  return Math.min(generation, MAX_GENERATION);
}

function shouldAcceptGeneration(current, incoming) {
  var currentValue = Math.max(0, Math.floor(Number(current) || 0));
  var incomingValue = Math.floor(Number(incoming));
  if (!isFinite(incomingValue) || incomingValue < 0 || incomingValue > MAX_GENERATION) return false;
  return incomingValue >= currentValue;
}

// The privacy latch floor must survive a panel close: resetting the local
// generation to 0 would make every replayed pre-lock snapshot acceptable again.
function latchFloor(current, incoming) {
  return Math.max(clampGeneration(current), clampGeneration(incoming));
}

function remainingSeconds(validUntil, now) {
  var end = Math.floor(Number(validUntil) || 0);
  var current = Math.floor(Number(now) || 0);
  return Math.max(0, end - current);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MAX_HELPER_BYTES: MAX_HELPER_BYTES,
    MAX_HELPER_ENTRIES: MAX_HELPER_ENTRIES,
    MAX_GENERATION: MAX_GENERATION,
    utf8ByteLength: utf8ByteLength,
    sanitizeText: sanitizeText,

    safeHelperCode: safeHelperCode,
    parseHelperSnapshot: parseHelperSnapshot,
    filterEntries: filterEntries,
    clampGeneration: clampGeneration,
    latchFloor: latchFloor,
    shouldAcceptGeneration: shouldAcceptGeneration,
    remainingSeconds: remainingSeconds
  };
}
