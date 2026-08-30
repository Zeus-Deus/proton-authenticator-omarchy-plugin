// Pure helpers for the Proton Authenticator Omarchy companion.
// No Qt imports: QML loads this via `import "Model.js" as Model`, while Node's
// test runner exercises the same parsers and command builders.
//
// Security boundary: this plugin NEVER reads Proton's IndexedDB, OS-keyring
// storage key, Proton session, TOTP seeds, or generated codes. It can only
// detect/focus/launch the official content-protected application.

var MAX_RESPONSE_BYTES = 256 * 1024;
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
    sanitizeText: sanitizeText,
    safeBinaryPath: safeBinaryPath,
    safeWindowAddress: safeWindowAddress,
    parseJson: parseJson,
    isAuthenticatorClient: isAuthenticatorClient,
    parseClients: parseClients,
    launchArgs: launchArgs,
    focusArgs: focusArgs,
    heroMeta: heroMeta
  };
}
