// Pure helpers for the Proton Authenticator Omarchy companion.
// No Qt imports: QML loads this via `import "Model.js" as Model`, while Node's
// test runner exercises the same parsers and command builders.
//
// Security boundary: this plugin NEVER reads Proton's IndexedDB, OS-keyring
// storage key, Proton session, TOTP seeds, or generated codes. It can only
// detect/focus/launch the official content-protected application.

var MAX_RESPONSE_BYTES = 256 * 1024;
var MAX_HELPER_BYTES = 1024 * 1024;
var MAX_HELPER_ENTRIES = 200;
var MAX_TEXT = 160;

function sanitizeText(value, limit) {
  var s = String(value === undefined || value === null ? "" : value);
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  s = s.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s.replace(/\s+/g, " ").replace(/^ +| +$/g, "");
  var max = limit === undefined ? MAX_TEXT : Math.max(0, Number(limit) || 0);
  if (s.length > max) s = s.slice(0, Math.max(0, max - 1)) + "\u2026";
  return s;
}

function safeBinaryPath(value) {
  var s = String(value || "");
  if (s === "" || s.charAt(0) !== "/" || s.length > 4096) return "";
  if (/[\u0000-\u001F\u007F]/.test(s)) return "";
  return s;
}

function safeWindowAddress(value) {
  var s = String(value || "");
  return /^0x[0-9a-fA-F]+$/.test(s) ? s : "";
}

function parseJson(text) {
  var s = String(text || "");
  if (s === "" || s.length > MAX_RESPONSE_BYTES) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function isAuthenticatorClient(client) {
  if (!client || typeof client !== "object") return false;
  var className = String(client.class || client.initialClass || "").toLowerCase();
  // Known official Linux identifiers: Flatpak/reverse-DNS plus the Tauri
  // AppImage classes observed with and without a separator. Never trust a
  // title-only match; any local process can choose that title.
  return className === "me.proton.authenticator"
    || className === "proton authenticator"
    || className === "proton-authenticator";
}

function parseClients(text) {
  var none = { running: false, address: "", title: "" };
  var data = parseJson(text);
  if (!(data instanceof Array)) return none;

  for (var i = 0; i < data.length; i++) {
    var client = data[i];
    if (!isAuthenticatorClient(client)) continue;
    var address = safeWindowAddress(client.address);
    if (address === "") continue;
    return {
      running: true,
      address: address,
      title: sanitizeText(client.title || client.initialTitle || "Proton Authenticator", 80)
    };
  }
  return none;
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
  if (raw === "" || raw.length > MAX_HELPER_BYTES) return emptyHelperSnapshot("Invalid helper response");

  var data;
  try { data = JSON.parse(raw); } catch (e) { return emptyHelperSnapshot("Invalid helper response"); }
  if (!data || typeof data !== "object" || data.v !== 1 || data.ok !== true)
    return emptyHelperSnapshot(data && data.error ? data.error : "Helper unavailable");

  var allowedStates = { ready: true, locked: true, needs_login: true, unavailable: true, error: true };
  var state = String(data.state || "unavailable");
  if (!allowedStates[state]) state = "error";
  var now = Math.max(0, Math.floor(Number(data.now) || 0));
  var generation = Math.max(0, Math.floor(Number(data.generation) || 0));
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

function remainingSeconds(validUntil, now) {
  var end = Math.floor(Number(validUntil) || 0);
  var current = Math.floor(Number(now) || 0);
  return Math.max(0, end - current);
}

function launchArgs(binaryPath, gpuWorkaround) {
  var binary = safeBinaryPath(binaryPath);
  if (binary === "") return [];
  return gpuWorkaround === true
    ? ["env", "WEBKIT_DISABLE_DMABUF_RENDERER=1", binary]
    : [binary];
}

function focusArgs(address) {
  var safe = safeWindowAddress(address);
  return safe === "" ? [] : ["hyprctl", "dispatch", "focuswindow", "address:" + safe];
}

function heroMeta(state) {
  var s = state || {};
  var error = sanitizeText(s.error || "", 120);
  if (error !== "") return error;
  if (s.checked !== true) return "Looking for the official app\u2026";
  if (s.installed !== true) return "Official app not installed";
  return s.running === true ? "Authenticator is open" : "Ready \u2014 codes stay inside Proton";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    MAX_HELPER_BYTES: MAX_HELPER_BYTES,
    MAX_HELPER_ENTRIES: MAX_HELPER_ENTRIES,
    sanitizeText: sanitizeText,
    safeBinaryPath: safeBinaryPath,
    safeWindowAddress: safeWindowAddress,
    parseJson: parseJson,
    isAuthenticatorClient: isAuthenticatorClient,
    parseClients: parseClients,
    safeHelperCode: safeHelperCode,
    parseHelperSnapshot: parseHelperSnapshot,
    filterEntries: filterEntries,
    remainingSeconds: remainingSeconds,
    launchArgs: launchArgs,
    focusArgs: focusArgs,
    heroMeta: heroMeta
  };
}
