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
  // Braille blank, combining grapheme joiner, interlinear annotation marks and
  // object replacement, Khmer inherent vowels, and musical format controls.
  s = s.replace(/[\u2800\u034F\uFFF9-\uFFFC\u17B4\u17B5]/g, "");
  s = s.replace(/\uD834[\uDD73-\uDD7A]/g, "");
  // Variation selectors: the BMP block and the supplementary VS17..VS256 block.
  s = s.replace(/[\uFE00-\uFE0F]/g, "");
  s = s.replace(/\uDB40[\uDD00-\uDDEF]/g, "");
  s = s.replace(/\uDB40[\uDC00-\uDC7F]/g, "");
  s = s.replace(/\s+/g, " ").replace(/^ +| +$/g, "");
  var max = limit === undefined ? MAX_TEXT : Math.max(0, Number(limit) || 0);
  return truncateUtf8(s, max);
}

// Client-side error text is shown in the hero and returned by the `status` IPC
// verb, so it must be one of a fixed set rather than whatever a Python
// exception or a JSON body happened to contain.
var ERROR_MESSAGES = {
  "helper runtime directory is unavailable": "Secure helper is not running",
  "helper socket is unavailable": "Secure helper is not running",
  "helper runtime path is not a directory": "Secure helper socket failed its safety check",
  "helper runtime directory has a foreign owner": "Secure helper socket failed its safety check",
  "helper runtime directory is not owner-private": "Secure helper socket failed its safety check",
  "helper path is not a socket": "Secure helper socket failed its safety check",
  "helper socket has a foreign owner": "Secure helper socket failed its safety check",
  "helper socket is not owner-private": "Secure helper socket failed its safety check",
  "helper response timeout": "Secure helper did not respond",
  "helper response exceeds size limit": "Secure helper sent an invalid response",
  "invalid helper response": "Secure helper sent an invalid response",
  "helper client rejected": "Secure helper is not running",
  "stale": "Codes paused · waiting for the helper",
  "locked": "Helper copy cleared",
  "not_found": "That code is no longer available",
  "invalid_item_id": "Invalid code item",
  "clipboard_failed": "Could not write the clipboard",
  "unsupported_operation": "Secure helper rejected the request",
  "invalid_request": "Secure helper rejected the request",
  "response_too_large": "Secure helper sent an invalid response"
};

function publicError(value) {
  var key = String(value === undefined || value === null ? "" : value);
  if (key === "") return "";
  if (ERROR_MESSAGES.hasOwnProperty(key)) return ERROR_MESSAGES[key];
  return "Secure helper unavailable";
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
    stale: false,
    synced: false,
    account: "",
    generation: 0,
    instance: "",
    sourceCommit: "",
    now: 0,
    entries: [],
    error: publicError(error || "helper client rejected")
  };
}

// Helper instance identifiers are 32 lowercase hex characters (a 128-bit
// per-process nonce); anything else is treated as absent.
function safeInstance(value) {
  var s = String(value === undefined || value === null ? "" : value);
  return /^[0-9a-f]{1,64}$/.test(s) ? s : "";
}

// The commit the running helper was built from, as embedded by its build.rs:
// a 40-hex git hash, optionally suffixed `-dirty`, or `unknown`.
function safeSourceCommit(value) {
  var s = String(value === undefined || value === null ? "" : value);
  return /^([0-9a-f]{40}(-dirty)?|unknown)$/.test(s) ? s : "";
}

function parseHelperSnapshot(text) {
  var raw = String(text || "");
  // The cap is UTF-8 bytes, matching the documented limit and the Python
  // client's own byte cap. raw.length counts UTF-16 units, which accepted a
  // 1.2 MB non-ASCII payload past a nominal 1 MiB limit.
  if (raw === "" || utf8ByteLength(raw) > MAX_HELPER_BYTES) return emptyHelperSnapshot("invalid helper response");

  var data;
  try { data = JSON.parse(raw); } catch (e) { return emptyHelperSnapshot("invalid helper response"); }
  if (!data || typeof data !== "object" || data.v !== 1 || data.ok !== true)
    return emptyHelperSnapshot(data && data.error ? data.error : "helper client rejected");

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
    // A row whose window has already closed by the helper's own clock is not a
    // current code; the helper's TTL bounds how stale a snapshot can be, but
    // the panel must not render "0s" beside a code that has rolled over.
    if (now > 0 && validUntil <= now) continue;
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
    // The helper expires its own snapshot: a publisher that stalled behind a
    // hidden webview degrades `ready` to `unavailable` with no rows and sets
    // this flag. It is transient, not breakage, and must read as such.
    stale: data.stale === true,
    synced: data.synced === true,
    account: sanitizeText(data.account || "", 120),
    generation: generation,
    instance: safeInstance(data.instance),
    sourceCommit: safeSourceCommit(data.sourceCommit),
    now: now,
    entries: entries,
    error: publicError(data.error || "")
  };
}

// Whether a row set actually changed. Rows are compared field by field so the
// panel can keep its Repeater delegates (and the hover/keyboard cursor state
// they carry) when a poll returns the same codes it already shows.
function entriesEqual(a, b) {
  var left = a instanceof Array ? a : [];
  var right = b instanceof Array ? b : [];
  if (left.length !== right.length) return false;
  var fields = ["id", "name", "issuer", "type", "code", "nextCode", "period", "validUntil"];
  for (var i = 0; i < left.length; i++) {
    var x = left[i] || {};
    var y = right[i] || {};
    for (var f = 0; f < fields.length; f++) {
      if (x[fields[f]] !== y[fields[f]]) return false;
    }
  }
  return true;
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

// The floor is per helper process. Generations restart at 1 whenever the helper
// restarts (which is also the only way out of a lock), so a floor carried over
// from the previous process would reject every fresh snapshot until the new
// process had published as many times as the old one had — silently, for
// possibly hours. A response that names a different instance therefore resets
// the floor. A response without an instance keeps the old behaviour: the floor
// stays, so a helper that predates the field cannot be replayed against.
function nextLatchState(currentInstance, currentFloor, incomingInstance, incomingGeneration) {
  var knownInstance = safeInstance(currentInstance);
  var seenInstance = safeInstance(incomingInstance);
  if (seenInstance !== "" && seenInstance !== knownInstance) {
    return { instance: seenInstance, floor: clampGeneration(incomingGeneration), reset: knownInstance !== "" };
  }
  return {
    instance: knownInstance || seenInstance,
    floor: latchFloor(currentFloor, incomingGeneration),
    reset: false
  };
}

// Whether a snapshot should be applied: either it is from a helper process we
// have not seen (the floor resets), or it is at or above the current floor.
function acceptsSnapshot(currentInstance, currentFloor, incomingInstance, incomingGeneration) {
  var knownInstance = safeInstance(currentInstance);
  var seenInstance = safeInstance(incomingInstance);
  if (seenInstance !== "" && seenInstance !== knownInstance) return clampGeneration(incomingGeneration) >= 0;
  return shouldAcceptGeneration(currentFloor, incomingGeneration);
}

function remainingSeconds(validUntil, now) {
  var end = Math.floor(Number(validUntil) || 0);
  var current = Math.floor(Number(now) || 0);
  return Math.max(0, end - current);
}

// A snapshot the helper has expired carries no rows, so the panel must tell the
// difference between "waiting for the app to republish" and a real failure.
function isPaused(view) {
  var v = view || {};
  return v.ok === true && v.stale === true && v.state === "unavailable";
}

function parseCopyResponse(text) {
  var data = null;
  try { data = JSON.parse(String(text || "")); } catch (e) { data = null; }
  var ok = !!data && typeof data === "object" && data.v === 1
    && data.ok === true && data.copied === true;
  var code = !ok && data && typeof data === "object" ? String(data.error || "") : "";
  return { ok: ok, stale: code === "stale", error: publicError(code) };
}

// The lock response carries the helper's new generation and its instance so the
// panel can raise its floor against exactly that process.
function parseLockResponse(text) {
  var data = null;
  try { data = JSON.parse(String(text || "")); } catch (e) { data = null; }
  var ok = !!data && typeof data === "object" && data.v === 1
    && data.ok === true && data.locked === true;
  return {
    ok: ok,
    generation: ok ? clampGeneration(data.generation) : 0,
    instance: ok ? safeInstance(data.instance) : ""
  };
}

function copyStatusMessage(result) {
  var value = result || {};
  if (value.ok === true) return "Code copied";
  if (value.stale === true) return "Codes paused · waiting for the helper";
  return "Could not copy code";
}

// Panel wording. Hiding is panel-local: the helper keeps its copy of the codes
// until its own lock clears them, so no message may imply the helper forgot
// anything the panel merely stopped drawing.
function statusMessage(view) {
  var v = view || {};
  if (v.checked !== true) return "Connecting to secure helper…";
  if (v.hidden === true) return "Codes hidden in this panel";
  if (v.available !== true) return publicError(v.error) || "Secure helper unavailable";
  if (v.paused === true) return "Codes paused · waiting for the helper";
  if (v.state === "needs_login") return "Sign in to enable encrypted sync";
  if (v.locked === true) return "Helper copy cleared";
  if (v.error) return publicError(v.error);
  var count = Math.max(0, Math.floor(Number(v.entryCount) || 0));
  return count + (count === 1 ? " code" : " codes") + (v.synced === true ? " · synced" : " · local");
}

var HELPER_RESTART_COMMAND = "systemctl --user restart proton-authenticator-omarchy-helper";

function hintMessage(view) {
  var v = view || {};
  if (v.hidden === true)
    return "Rows are hidden in this panel only. The helper still holds the codes until you clear its copy.";
  if (v.paused === true)
    return "The helper's last snapshot expired. Rows return as soon as the Proton helper publishes again.";
  if (v.state === "needs_login")
    return "Sign in through the pinned Proton helper once. Normal code access stays in this popup.";
  if (v.locked === true)
    return "The helper cleared its copy of the codes. To get them back, restart it: " + HELPER_RESTART_COMMAND;
  return "The pinned Proton helper is not available yet.";
}

var LOCK_CONFIRM_MESSAGE =
  "Clear the helper's copy of every code? This cannot be undone from the panel; " +
  "the helper stays locked until you run " + HELPER_RESTART_COMMAND + ".";

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MAX_HELPER_BYTES: MAX_HELPER_BYTES,
    MAX_HELPER_ENTRIES: MAX_HELPER_ENTRIES,
    MAX_GENERATION: MAX_GENERATION,
    HELPER_RESTART_COMMAND: HELPER_RESTART_COMMAND,
    LOCK_CONFIRM_MESSAGE: LOCK_CONFIRM_MESSAGE,
    utf8ByteLength: utf8ByteLength,
    sanitizeText: sanitizeText,
    publicError: publicError,
    safeInstance: safeInstance,
    safeSourceCommit: safeSourceCommit,
    safeHelperCode: safeHelperCode,
    parseHelperSnapshot: parseHelperSnapshot,
    entriesEqual: entriesEqual,
    filterEntries: filterEntries,
    clampGeneration: clampGeneration,
    latchFloor: latchFloor,
    nextLatchState: nextLatchState,
    acceptsSnapshot: acceptsSnapshot,
    shouldAcceptGeneration: shouldAcceptGeneration,
    remainingSeconds: remainingSeconds,
    isPaused: isPaused,
    parseCopyResponse: parseCopyResponse,
    parseLockResponse: parseLockResponse,
    copyStatusMessage: copyStatusMessage,
    statusMessage: statusMessage,
    hintMessage: hintMessage
  };
}
