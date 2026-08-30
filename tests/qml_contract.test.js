const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const service = fs.readFileSync(path.join(__dirname, '..', 'Service.qml'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '..', 'Panel.qml'), 'utf8');
const serviceCode = service.replace(/\/\/.*$/gm, '');
const executableCode = (service + panel).replace(/\/\/.*$/gm, '');

test('refresh re-probes the executable after an explicit install', () => {
  assert.match(serviceCode, /function refresh\(\)\s*\{\s*if \(!installed\) \{ start\(\); return \}/);
});

test('status polling runs only while the panel is open', () => {
  assert.match(service, /running:\s*root\.panelOpen/);
});

test('the panel never renders or copies TOTP material', () => {
  assert.doesNotMatch(executableCode, /wl-copy|generateCode|generate_code|IndexedDB|keyring.*get|clipboard.*read/i);
});

test('the installer handoff stays visible and prompting', () => {
  assert.match(service, /omarchy-launch-terminal.*python3.*installerPath/);
  assert.doesNotMatch(service, /install_official_appimage\.py.*--yes/);
});
