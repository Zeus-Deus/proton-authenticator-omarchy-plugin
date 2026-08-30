const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const service = fs.readFileSync(path.join(__dirname, '..', 'Service.qml'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '..', 'Panel.qml'), 'utf8');
const executableCode = (service + panel).replace(/\/\/.*$/gm, '');

test('snapshot polling uses the bounded local helper client only while the panel is open', () => {
  assert.match(service, /helper_client\.py/);
  assert.match(service, /snapshot/);
  assert.match(service, /Model\.parseHelperSnapshot/);
  assert.match(service, /running:\s*root\.panelOpen/);
});

test('the panel renders current and next codes from validated helper rows', () => {
  assert.match(panel, /entry\.code/);
  assert.match(panel, /entry\.nextCode/);
  assert.match(panel, /remainingSeconds/);
});

test('ready local state exposes a Proton sync sign-in action', () => {
  assert.match(panel, /Sign in to Proton sync/);
  assert.match(panel, /!authenticator\.synced/);
  assert.match(panel, /authenticator\.launchLogin\(\)/);
});

test('copy sends only an opaque item id to the helper', () => {
  assert.match(service, /function copyCode\(itemId\)/);
  assert.match(service, /"copy",\s*id/);
  assert.doesNotMatch(executableCode, /wl-copy|xclip|clipboard.*write|clipboard.*read/i);
});

test('QML never implements Proton auth, vault reads, or code generation', () => {
  assert.doesNotMatch(executableCode, /generateCode|generate_code|IndexedDB|keyring.*get|password|accessToken|refreshToken/i);
});

test('login handoff launches a fixed helper executable without credentials', () => {
  assert.match(service, /proton-authenticator-omarchy-helper/);
  assert.doesNotMatch(service, /launchLogin[\s\S]{0,500}(password|token|secret)/i);
});
