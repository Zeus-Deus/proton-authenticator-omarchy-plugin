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
// Helper feature level this panel needs: the `open` op, `latched`, and
// `binaryReplaced`. An older helper still serves codes but is reported as
// needing an update.
var REQUIRED_HELPER_API = 2;
var HELPER_PACKAGE = "proton-authenticator-omarchy-helper";
var HELPER_UNIT = "proton-authenticator-omarchy-helper.service";

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
  "invalid_view": "Secure helper rejected the request",
  "invalid view": "Secure helper rejected the request",
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
    api: 0,
    helperVersion: "",
    latched: false,
    binaryReplaced: false,
    now: 0,
    entries: [],
    error: publicError(error || "helper client rejected")
  };
}

// A generation above the cap is not something a real helper produces. Clamping
// it would still raise the panel's floor to the cap and silently reject every
// genuine snapshot until the helper restarted, so the whole response is
// rejected instead.
function generationInRange(value) {
  if (value === undefined || value === null) return true;
  var n = Number(value);
  return isFinite(n) && n >= 0 && n <= MAX_GENERATION;
}

function safeHelperVersion(value) {
  var s = String(value === undefined || value === null ? "" : value);
  return /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(\+omarchy\.[0-9]{1,6})?$/.test(s) ? s : "";
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
  if (!generationInRange(data.generation)) return emptyHelperSnapshot("invalid helper response");

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
    api: Math.max(0, Math.min(255, Math.floor(Number(data.api) || 0))),
    helperVersion: safeHelperVersion(data.helperVersion),
    latched: data.latched === true,
    binaryReplaced: data.binaryReplaced === true,
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

// Result of `helper_client.py probe`: local facts only (package installed,
// unit state, a leftover pre-package development install), never a socket.
function parseProbe(text) {
  var data = null;
  try { data = JSON.parse(String(text || "")); } catch (e) { data = null; }
  if (!data || typeof data !== "object" || data.v !== 1 || data.ok !== true)
    return { ok: false, installed: false, unit: "unknown", legacy: false, conflict: false };
  var units = { active: true, activating: true, inactive: true, failed: true, deactivating: true };
  var unit = String(data.unit || "");
  return {
    ok: true,
    installed: data.installed === true,
    unit: units[unit] ? unit : "unknown",
    legacy: data.legacy === true,
    conflict: data.conflict === true
  };
}

// Single source of truth for what the panel shows and what its main button
// does. Each phase has exactly one primary action.
//   install   — helper package missing (or a conflicting Proton app is)
//   migrate   — only the old hand-built development helper is present
//   start     — package installed, service not running
//   starting  — service running, socket not up yet
//   update    — running helper is older than this panel needs
//   restart   — package upgraded but the old process is still serving
//   locked    — helper copy cleared; a restart brings codes back
//   signin    — helper up, no Proton account yet
//   paused    — helper up, its web view has not published recently
//   hidden    — rows hidden in this panel only
//   ready     — codes available
function setupPhase(view) {
  var v = view || {};
  if (v.hidden === true) return "hidden";
  if (v.available !== true) {
    var p = v.probe || {};
    if (p.ok !== true) return "starting";
    if (p.conflict === true) return "install";
    if (p.legacy === true) return "migrate";
    if (p.installed !== true) return "install";
    if (p.unit === "active" || p.unit === "activating") return "starting";
    return "start";
  }
  if (v.latched === true) return "locked";
  if (Math.floor(Number(v.api) || 0) < REQUIRED_HELPER_API) {
    // An old helper is answering. Which fix applies depends on what is on
    // disk: a leftover hand-built install is switched over (no download); an
    // installed package means the old process predates it and only needs a
    // restart; otherwise fetch the package.
    var q = v.probe || {};
    if (q.ok === true && q.legacy === true) return "migrate";
    if (q.ok === true && q.installed === true) return "restart";
    return "update";
  }
  if (v.binaryReplaced === true) return "restart";
  // Proton's own app lock (PIN/password set in Proton's settings), as opposed
  // to this panel's one-way latch above.
  if (v.locked === true) return "applock";
  if (v.paused === true) return "paused";
  if (v.state === "ready") return "ready";
  if (v.state === "needs_login") return "signin";
  return "paused";
}

function primaryAction(phase) {
  switch (phase) {
    case "install": return { id: "install", label: "Install secure helper" };
    case "migrate": return { id: "install", label: "Switch to the packaged helper" };
    case "update": return { id: "install", label: "Update secure helper" };
    case "start": return { id: "start", label: "Start secure helper" };
    case "restart": return { id: "restart", label: "Restart helper to finish updating" };
    case "locked": return { id: "restart", label: "Restart helper to show codes again" };
    case "applock": return { id: "manage", label: "Unlock in Proton Authenticator" };
    case "signin": return { id: "login", label: "Sign in with Proton" };
    case "paused": return { id: "refresh", label: "Check again" };
    case "hidden": return { id: "show", label: "Show codes in this panel" };
    case "starting": return { id: "refresh", label: "Check again" };
    default: return { id: "", label: "" };
  }
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
    && data.ok === true && data.locked === true && generationInRange(data.generation);
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
  if (v.available !== true) {
    var phase = setupPhase(v);
    if (phase === "install") return (v.probe && v.probe.conflict) ? "Proton's own app is installed" : "Secure helper not installed";
    if (phase === "migrate") return "Development helper found";
    if (phase === "start") return "Secure helper is stopped";
    return publicError(v.error) || "Secure helper unavailable";
  }
  if (v.latched === true) return "Helper copy cleared";
  if (Math.floor(Number(v.api) || 0) < REQUIRED_HELPER_API) {
    var old = setupPhase(v);
    if (old === "migrate") return "Development helper running";
    if (old === "restart") return "Update installed · restart pending";
    return "Secure helper needs an update";
  }
  if (v.binaryReplaced === true) return "Update installed · restart pending";
  if (v.paused === true) return "Codes paused · waiting for the helper";
  if (v.state === "needs_login") return "Sign in to enable encrypted sync";
  if (v.locked === true) return "Locked by Proton's app lock";
  if (v.error) return publicError(v.error);
  var count = Math.max(0, Math.floor(Number(v.entryCount) || 0));
  return count + (count === 1 ? " code" : " codes") + (v.synced === true ? " · synced" : " · local");
}

var HELPER_RESTART_COMMAND = "systemctl --user restart proton-authenticator-omarchy-helper";

function hintMessage(view) {
  var v = view || {};
  var phase = setupPhase(v);
  if (phase === "install" && v.probe && v.probe.conflict)
    return "The helper replaces Proton's own Linux app (they share one data folder and cannot run together). Your codes stay on your Proton account.";
  if (phase === "install")
    return "Codes come from Proton's official Authenticator, built from source with a private local socket. One-time install from the AUR; omarchy update keeps it current.";
  if (phase === "migrate")
    return "A hand-built development helper is running. Switch to the packaged one so omarchy update keeps it current. Your codes and sign-in are kept.";
  if (phase === "start") return "The helper is installed but not running.";
  if (phase === "starting") return "Waiting for the secure helper to start…";
  if (phase === "update")
    return "The running helper is older than this panel. Update it; your codes and sign-in are kept.";
  if (phase === "restart")
    return "A new helper version is installed. It switches over by itself when the Proton window is closed, or restart it now.";
  if (v.hidden === true)
    return "Rows are hidden in this panel only. The helper still holds the codes until you clear its copy.";
  if (v.latched === true)
    return "The helper cleared its copy of the codes. Restarting it brings them back.";
  if (v.locked === true)
    return "Proton Authenticator is locked with its own PIN or password. Unlock it in Proton's window.";
  if (v.paused === true)
    return "The helper's last snapshot expired. Rows return as soon as the Proton helper publishes again.";
  if (v.state === "needs_login")
    return "Sign in once in Proton's own window. Your codes then sync from your other devices and stay in this popup.";
  return "The pinned Proton helper is not available yet.";
}

var LOCK_CONFIRM_MESSAGE =
  "Clear the helper's copy of every code? Codes stay hidden everywhere until " +
  "you restart the helper from this panel.";

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MAX_HELPER_BYTES: MAX_HELPER_BYTES,
    MAX_HELPER_ENTRIES: MAX_HELPER_ENTRIES,
    MAX_GENERATION: MAX_GENERATION,
    REQUIRED_HELPER_API: REQUIRED_HELPER_API,
    HELPER_PACKAGE: HELPER_PACKAGE,
    HELPER_UNIT: HELPER_UNIT,
    generationInRange: generationInRange,
    safeHelperVersion: safeHelperVersion,
    parseProbe: parseProbe,
    setupPhase: setupPhase,
    primaryAction: primaryAction,
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
