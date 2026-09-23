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
  // snapshot, copy, lock, open, probe go through the client; the two unit
  // actions call systemctl directly by absolute path.
  assert.equal(spawns.length, 7);
  const client = spawns.filter((spawn) => /\[pythonBinary,/.test(spawn));
  const unit = spawns.filter((spawn) => /\[systemctl,/.test(spawn));
  assert.equal(client.length, 5);
  assert.equal(unit.length, 2);
  assert.match(service, /readonly property string systemctl:\s*"\/usr\/bin\/systemctl"/);
  for (const spawn of unit) assert.match(spawn, /\[systemctl, "--user", "(enable", "--now|restart)", helperUnit\]/);
});

test('panel close clears rows and snapshot output is not retained in a collector', () => {
  assert.match(panel, /else\s*\{[\s\S]{0,160}authenticator\.clearVisibleRows\(\)/);
  assert.match(service, /function clearVisibleRows\(\)/);
  assert.match(service, /stdout:\s*SplitParser\s*\{[\s\S]{0,180}applySnapshot/);
  assert.doesNotMatch(service, /snapshotOut|stdout:\s*StdioCollector\s*\{\s*id:\s*snapshot/);
  assert.match(service, /function clearVisibleRows\(\)[\s\S]{0,260}entries = \[\]/);
  assert.match(service, /if \(!panelOpen && next\.ok\) return/);
});

test('the privacy latch floor survives a panel close instead of resetting to zero', () => {
  assert.match(service, /property int latchFloor: 0/);
  assert.match(service, /property string helperInstance: ""/);
  assert.doesNotMatch(service, /function clearVisibleRows\(\)[\s\S]{0,260}generation = 0/);
  assert.match(service, /function clearVisibleRows\(\)[\s\S]{0,260}latchFloor = Model\.latchFloor\(latchFloor, generation\)/);
  assert.match(service, /function clearVisibleRows\(\)[\s\S]{0,300}generation = latchFloor/);
  // Every generation write goes through the floor: either the plain monotonic
  // floor (panel close) or the instance-aware one (snapshot / lock responses).
  assert.doesNotMatch(service, /generation = Math\.floor\(Number\(response\.generation\)\)/);
  assert.doesNotMatch(executableCode, /generation = next\.generation/);
  assert.doesNotMatch(executableCode, /generation = response\.generation/);
  assert.equal((service.match(/Model\.latchFloor\(/g) || []).length, 1);
  assert.equal((service.match(/Model\.nextLatchState\(/g) || []).length, 2);
  // Acceptance is instance-aware on both paths that can raise the floor.
  assert.match(service, /if \(next\.ok && !Model\.acceptsSnapshot\(helperInstance, generation, next\.instance, next\.generation\)\) return/);
  assert.match(service, /Model\.acceptsSnapshot\(root\.helperInstance, root\.generation, response\.instance, response\.generation\)/);
  assert.doesNotMatch(executableCode, /Model\.shouldAcceptGeneration\(/);
  // The floor may only reset through Model.nextLatchState; nothing zeroes it.
  assert.doesNotMatch(executableCode, /latchFloor = 0/);
  assert.doesNotMatch(executableCode, /helperInstance = ""/);
});

test('snapshot polling keeps Repeater delegates when rows did not change', () => {
  assert.match(service, /if \(!Model\.entriesEqual\(entries, nextEntries\)\) entries = nextEntries/);
  assert.doesNotMatch(service, /function applySnapshot[\s\S]*?\n {4}entries = panelOpen \? next\.entries : \[\]/);
});

test('every external executable is an absolute path', () => {
  assert.match(service, /readonly property string browserLauncher:\s*"\/usr\/share\/omarchy\/bin\/omarchy-launch-browser"/);
  assert.match(service, /readonly property string terminalLauncher:\s*"\/usr\/share\/omarchy\/bin\/omarchy-launch-floating-terminal-with-presentation"/);
  const detached = executableCode.match(/execDetached\(\[[\s\S]*?\]\)/g) || [];
  assert.equal(detached.length, 2);
  for (const call of detached) assert.doesNotMatch(call, /\[\s*"[^\/]/);
  // The installer's only argument is a fixed mode; the script path is quoted.
  assert.match(service, /execDetached\(\[terminalLauncher, Util\.shellQuote\(setupScript\) \+ " " \+ arg\]\)/);
  assert.match(service, /var arg = mode === "update" \? "update" : "install"/);
});

test('the panel renders current and next codes from validated helper rows', () => {
  assert.match(panel, /entry\.code/);
  assert.match(panel, /entry\.nextCode/);
  assert.match(panel, /remainingSeconds/);
});

test('reopen and search reset the scroll position', () => {
  assert.match(panel, /if \(opened\) \{[\s\S]{0,400}panelFlick\.contentY = 0/);
  assert.match(panel, /function setFilter\(text\) \{[\s\S]{0,200}panelFlick\.contentY = 0/);
});

test('ready local state exposes Proton sign-in, add, and manage through the running helper', () => {
  assert.match(panel, /Sign in to Proton sync/);
  assert.match(panel, /!authenticator\.synced/);
  assert.match(panel, /onClicked: root\.openProton\("login"\)/);
  assert.match(panel, /onClicked: root\.openProton\("add"\)/);
  assert.match(panel, /onClicked: root\.openProton\("manage"\)/);
  // Proton's window opens under the full-screen panel layer: close first.
  assert.match(panel, /function openProton\(view\) \{\s*root\.close\(\)\s*authenticator\.openView\(view\)/);
  // Views are a fixed allow-list, sent to the socket, never exec'd.
  assert.match(service, /\["login", "manage", "add"\]\.indexOf\(view\) === -1/);
  assert.match(service, /openProcess\.command = \[pythonBinary, clientPath, "open", view\]/);
});

test('copy sends only an opaque item id to the helper', () => {
  assert.match(service, /function copyCode\(itemId\)/);
  assert.match(service, /"copy",\s*id/);
  assert.doesNotMatch(executableCode, /wl-copy|xclip|clipboard.*write|clipboard.*read/i);
});

test('QML never implements Proton auth, vault reads, or code generation', () => {
  assert.doesNotMatch(executableCode, /generateCode|generate_code|IndexedDB|keyring.*get|password|accessToken|refreshToken/i);
});

test('the panel never sends a socket unlock and keeps show-codes panel-local', () => {
  assert.doesNotMatch(executableCode, /"unlock"/);
  assert.doesNotMatch(service, /unlockProcess|unlockResponse/);
  // showCodes only flips local state and resumes polling; it spawns nothing.
  const showCodes = service.match(/function showCodes\(\) \{[\s\S]*?\n  \}/)[0];
  assert.doesNotMatch(showCodes, /command\s*=/);
  assert.match(showCodes, /hidden = false/);
  assert.match(showCodes, /refresh\(\)/);
  // Hiding is local too: it must not spawn a helper request.
  const hideCodes = service.match(/function hideCodes\(\) \{[\s\S]*?\n  \}/)[0];
  assert.doesNotMatch(hideCodes, /command\s*=/);
  assert.match(hideCodes, /hidden = true/);
  // A hidden panel stops pulling live codes into this process.
  assert.match(service, /if \(!panelOpen \|\| hidden \|\|/);
});

test('the stronger helper-side lock stays reachable, one-way, and confirmed', () => {
  assert.match(service, /function lock\(\)[\s\S]{0,200}"lock"/);
  // Ctrl+X opens a confirmation; only the dialog's confirmed signal reaches lock().
  assert.match(panel, /key === Qt\.Key_X\) \{ root\.requestLock\(\)/);
  assert.match(panel, /ConfirmDialog \{[\s\S]*?onConfirmed: \{[\s\S]{0,120}authenticator\.lock\(\)/);
  const lockCalls = panel.match(/authenticator\.lock\(\)/g) || [];
  assert.equal(lockCalls.length, 2, 'lock() is reachable from the IPC verb and the confirmed dialog only');
  // The kit dialog defaults to Confirm; the panel must reset it to Cancel so
  // `x` then Enter cannot clear the helper.
  assert.match(panel, /function requestLock\(\)[\s\S]{0,300}lockConfirm\.selectedIndex = 0/);
  // The confirmation owns every key while open, so no shortcut fires under it.
  assert.match(panel, /if \(root\.lockConfirmOpen\) return\n\s*if \(root\.handleKey\(event\)\)/);
  assert.match(panel, /message: Model\.LOCK_CONFIRM_MESSAGE/);
  // Closing the panel discards a pending confirmation.
  assert.match(panel, /else \{[\s\S]{0,120}lockConfirmOpen = false/);
  assert.match(panel, /key === Qt\.Key_H\) \{ root\.toggleHidden\(\)/);
});

test('stale helper snapshots surface as a paused state, not as breakage', () => {
  assert.match(service, /property bool paused: false/);
  assert.match(service, /paused = Model\.isPaused\(next\)/);
  assert.match(service, /Model\.parseCopyResponse/);
  assert.match(service, /if \(result\.stale\)[\s\S]{0,200}root\.paused = true/);
  assert.match(panel, /!authenticator\.paused/);
  assert.match(panel, /Model\.statusMessage\(/);
  assert.match(panel, /Model\.hintMessage\(/);
});

test('the panel wording never claims the helper forgot codes it still holds', () => {
  const model = fs.readFileSync(path.join(__dirname, '..', 'Model.js'), 'utf8');
  assert.match(model, /Codes hidden in this panel/);
  assert.match(model, /hidden in this panel only/);
  assert.doesNotMatch(panel, /Show them again through the pinned helper/);
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

test('the panel never launches a helper binary of its own', () => {
  // The old path exec'd the binary, which reached the running service over
  // D-Bus or, if none ran, started a second process outside the sandbox.
  assert.doesNotMatch(executableCode, /helperBinary|--login|launchLogin/);
  assert.doesNotMatch(executableCode, /\.local\/bin\/proton-authenticator/);
  assert.doesNotMatch(service, /openView[\s\S]{0,600}(password|token|secret)/i);
});

test('the pinned helper commit matches the lock file and the AUR package', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'helper', 'proton-helper.lock.json'), 'utf8'));
  const pinned = lock.protonWebClients.helperCommit;
  assert.match(pinned, /^[0-9a-f]{40}$/);
  assert.match(service, new RegExp(`readonly property string helperCommit: "${pinned}"`));
  const pkgbuild = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'aur', 'PKGBUILD'), 'utf8');
  assert.match(pkgbuild, new RegExp(`^_patchcommit=${pinned}$`, 'm'));
  assert.match(pkgbuild, new RegExp(`^_protoncommit=${lock.protonWebClients.baseCommit}$`, 'm'));
  assert.match(pkgbuild, new RegExp(`^_protonver=${lock.protonWebClients.protonVersion.replace(/\./g, '\\.')}$`, 'm'));
});

test('every setup phase has a reachable panel action', () => {
  for (const id of ['install', 'start', 'restart', 'login', 'manage', 'add', 'show', 'refresh'])
    assert.match(panel, new RegExp(`case "${id}":`), id);
  assert.match(panel, /else if \(!root\.ready\) root\.runAction\(root\.primary\.id\)/);
  // An empty, signed-out helper: Enter signs in instead of doing nothing.
  assert.match(panel, /authenticator\.entryCount === 0\) root\.openProton\("login"\)/);
  assert.match(service, /function runSetup\(mode\)/);
  assert.match(service, /function startHelper\(\)/);
  assert.match(service, /function restartHelper\(\)/);
  // The probe runs only when the socket is down.
  assert.match(service, /if \(!next\.ok \|\| next\.api < Model\.REQUIRED_HELPER_API\) runProbe\(\)/);
});

test('the scroll target skips the Repeater that precedes the row delegates', () => {
  assert.match(panel, /var childIndex = selectedIndex \+ 1/);
  assert.match(panel, /codeColumn\.children\[childIndex\]/);
  assert.doesNotMatch(panel, /codeColumn\.children\[selectedIndex\]/);
});

test('the code list scrolls a fixed step per wheel notch, not a kinetic flick', () => {
  assert.match(panel, /WheelHandler \{[\s\S]{0,200}panelFlick\.contentY = Model\.wheelScroll\(panelFlick\.contentY/);
  assert.match(panel, /event\.accepted = true/);
});

test('a code rollover updates rows in place instead of rebuilding the list', () => {
  // The Repeater is keyed by the row count, so a new code for the same rows
  // keeps every delegate; each row reads its entry by index.
  assert.match(panel, /Repeater \{[\s\S]{0,300}model: root\.filteredEntries\.length/);
  assert.match(panel, /entry: root\.filteredEntries\[index\] \|\| \(\{\}\)/);
  assert.match(panel, /onTextChanged: codeFade\.restart\(\)/);
});

test('a copy confirms on the copied row by opaque id and never keeps the code', () => {
  assert.match(service, /property string copiedId: ""/);
  assert.match(service, /pendingCopyId = id/);
  assert.match(service, /if \(result\.ok\) \{\s*root\.copiedId = root\.pendingCopyId/);
  assert.match(panel, /authenticator\.copiedId === entry\.id/);
  assert.match(panel, /current: copied/);
  // The copied marker is cleared with the rows when the panel closes.
  assert.match(service, /function clearVisibleRows\(\)[\s\S]{0,120}copiedId = ""/);
  assert.doesNotMatch(service, /copiedCode|lastCode/);
});

// Runs the panel's real handleKey() in a VM with recording stubs, so the claim
// "typing never opens Proton" is checked against the shipped code, not a copy.
function keyHarness({ ready = true, entries = 3 } = {}) {
  const vm = require('node:vm');
  const body = panel.match(/  function handleKey\(event\) \{[\s\S]*?\n  \}\n/)[0];
  const calls = [];
  const Qt = {
    ControlModifier: 0x04000000, ShiftModifier: 0x02000000, AltModifier: 0x08000000, MetaModifier: 0x10000000,
    Key_Escape: 0x01000000, Key_Tab: 0x01000001, Key_Backtab: 0x01000002, Key_Backspace: 0x01000003,
    Key_Return: 0x01000004, Key_Enter: 0x01000005, Key_Home: 0x01000010, Key_End: 0x01000011,
    Key_Up: 0x01000013, Key_Down: 0x01000015, Key_PageUp: 0x01000016, Key_PageDown: 0x01000017,
  };
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') Qt['Key_' + c] = c.charCodeAt(0);
  const root = {
    filterText: '', ready, filteredEntries: new Array(entries).fill({}),
    setFilter(t) { this.filterText = t; calls.push(['filter', t]); },
    close() { calls.push(['close']); }, switchPanel() { calls.push(['switch']); },
    activate() { calls.push(['activate']); }, moveCursor(d) { calls.push(['move', d]); },
    selectAbsolute(i) { calls.push(['select', i]); }, openProton(v) { calls.push(['open', v]); },
    toggleHidden() { calls.push(['hide']); }, requestLock() { calls.push(['lock']); },
  };
  const authenticator = { available: true, entries: new Array(entries).fill({}), refresh() { calls.push(['refresh']); } };
  const Util = {
    editsFilter(e, t) { return !!t && e.key === Qt.Key_Backspace; },
    editedFilter(e, t) { return t.slice(0, -1); },
  };
  const ctx = vm.createContext({ Qt, root, authenticator, Util });
  vm.runInContext(body.replace('function handleKey', 'root.handleKey = function'), ctx);
  const press = (text, key, modifiers = 0) => ctx.root.handleKey({ text, key: key ?? (text ? text.toUpperCase().charCodeAt(0) : 0), modifiers });
  return { root, calls, press, Qt };
}

test('typing any printable key only searches; it never opens Proton or acts', () => {
  const h = keyHarness();
  const printable = [];
  for (let c = 32; c < 127; c++) printable.push(String.fromCharCode(c));
  for (const ch of printable) {
    const key = /[a-z]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : ch.charCodeAt(0);
    const shift = /[A-Z]/.test(ch) ? h.Qt.ShiftModifier : 0;
    assert.equal(h.press(ch, key, shift), true);
  }
  const actions = h.calls.filter(([verb]) => verb !== 'filter');
  assert.deepEqual(actions, [], 'a plain key triggered an action');
  assert.equal(h.root.filterText, printable.join(''));
});

test('actions live on Ctrl chords and Enter copies the best match', () => {
  const h = keyHarness();
  h.press('a', h.Qt.Key_A, h.Qt.ControlModifier);
  h.press('o', h.Qt.Key_O, h.Qt.ControlModifier);
  h.press('h', h.Qt.Key_H, h.Qt.ControlModifier);
  h.press('x', h.Qt.Key_X, h.Qt.ControlModifier);
  h.press('r', h.Qt.Key_R, h.Qt.ControlModifier);
  h.press('\r', h.Qt.Key_Return);
  h.press('', h.Qt.Key_Down);
  h.press('j', h.Qt.Key_J, h.Qt.ControlModifier);
  h.press('', h.Qt.Key_Up);
  assert.deepEqual(h.calls, [['open', 'add'], ['open', 'manage'], ['hide'], ['lock'], ['refresh'],
    ['activate'], ['move', 1], ['move', 1], ['move', -1]]);
  // Ctrl+X only asks for confirmation; nothing reaches the helper's lock.
  assert.doesNotMatch(panel.match(/  function handleKey[\s\S]*?\n  \}\n/)[0], /authenticator\.lock\(/);
});

test('Escape clears the search before it closes the panel; Backspace edits it', () => {
  const h = keyHarness();
  h.press('g'); h.press('h');
  h.press('', h.Qt.Key_Backspace);
  assert.equal(h.root.filterText, 'g');
  h.press('', h.Qt.Key_Escape);
  assert.equal(h.root.filterText, '');
  assert.equal(h.calls.some(([verb]) => verb === 'close'), false);
  h.press('', h.Qt.Key_Escape);
  assert.deepEqual(h.calls.at(-1), ['close']);
});

test('with no visible codes, typing does nothing at all', () => {
  const h = keyHarness({ ready: false, entries: 0 });
  for (const ch of 'amxLr/') h.press(ch);
  assert.deepEqual(h.calls, []);
});
