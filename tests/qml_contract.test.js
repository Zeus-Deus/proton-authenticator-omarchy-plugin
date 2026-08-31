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

test('every helper client spawn pins an absolute interpreter, never a PATH lookup', () => {
  assert.match(service, /readonly property string pythonBinary:\s*"\/usr\/bin\/python3"/);
  assert.doesNotMatch(executableCode, /command\s*=\s*\[\s*"python3"/);
  const spawns = service.match(/command\s*=\s*\[[^\]]*\]/g) || [];
  assert.equal(spawns.length, 4);
  for (const spawn of spawns) assert.match(spawn, /^command\s*=\s*\[pythonBinary,/);
});

test('panel close clears rows and snapshot output is not retained in a collector', () => {
  assert.match(panel, /else\s*\{[\s\S]{0,160}authenticator\.clearVisibleRows\(\)/);
  assert.match(service, /function clearVisibleRows\(\)/);
  assert.match(service, /stdout:\s*SplitParser\s*\{[\s\S]{0,180}applySnapshot/);
  assert.doesNotMatch(service, /snapshotOut|stdout:\s*StdioCollector\s*\{\s*id:\s*snapshot/);
  assert.match(service, /function clearVisibleRows\(\)[\s\S]{0,220}generation = 0/);
  assert.match(service, /if \(!panelOpen && next\.ok\) return/);
});

test('the panel renders current and next codes from validated helper rows', () => {
  assert.match(panel, /entry\.code/);
  assert.match(panel, /entry\.nextCode/);
  assert.match(panel, /remainingSeconds/);
});

test('reopen and search reset the scroll position', () => {
  assert.match(panel, /if \(opened\) \{[\s\S]{0,180}panelFlick\.contentY = 0/);
  assert.match(panel, /onTextChanged:[\s\S]{0,100}panelFlick\.contentY = 0/);
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

test('privacy latch restores rows through panel-focused unlock without opening Proton', () => {
  assert.match(service, /function showCodes\(\)[\s\S]{0,220}"unlock"/);
  assert.match(panel, /authenticator\.locked\)[\s\S]{0,100}authenticator\.showCodes\(\)/);
});

test('the IPC surface publishes only fail-safe verbs', () => {
  const ipc = panel.match(/IpcHandler\s*\{[\s\S]*?\n  \}/);
  assert.ok(ipc, 'IpcHandler block not found');
  const block = ipc[0];
  assert.doesNotMatch(block, /function unlock\b/);
  assert.doesNotMatch(block, /function copy\b/);
  assert.doesNotMatch(block, /function login\b/);
  assert.match(block, /function lock\(\): string/);
  assert.match(block, /function status\(\): string/);
  // `status` must never carry code material.
  const status = block.match(/function status\(\): string \{[\s\S]*?\n    \}/)[0];
  assert.doesNotMatch(status, /entries|\bcode\b|nextCode|validUntil/);
});

test('transient action feedback expires instead of becoming stale state', () => {
  assert.match(service, /function setActionStatus\(message\)/);
  assert.match(service, /id: actionClearTimer/);
  assert.match(service, /interval: 2500/);
  assert.match(service, /root\.actionStatus = ""/);
});

test('login handoff launches a fixed helper executable without credentials', () => {
  assert.match(service, /proton-authenticator-omarchy-helper/);
  assert.doesNotMatch(service, /launchLogin[\s\S]{0,500}(password|token|secret)/i);
});

test('review action opens the exact pinned helper commit', () => {
  assert.match(service, /WebClients\/commit\/f4793fcfdf15afefe1788a21df71399f729cd265/);
});
