const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const Model = require('../Model.js');

const root = path.join(__dirname, '..');
const fixture = path.join(root, 'tests', 'fixtures', 'fixture-server.mjs');
const client = path.join(root, 'scripts', 'helper_client.py');

function runClient(socketPath, args) {
  return childProcess.spawnSync('/usr/bin/python3', [client, ...args], {
    cwd: root,
    env: { ...process.env, PROTON_AUTH_HELPER_SOCKET: socketPath },
    encoding: 'utf8',
    timeout: 5000,
  });
}

// spawnSync blocks this process's event loop, which would stall any mock server
// running in-process. Tests with an in-process server must use this variant.
function runClientAsync(socketPath, args) {
  return new Promise((resolve) => {
    const child = childProcess.spawn('/usr/bin/python3', [client, ...args], {
      cwd: root,
      env: { ...process.env, PROTON_AUTH_HELPER_SOCKET: socketPath },
      timeout: 15000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('official-core fixture serves bounded RFC codes over a private Unix socket', async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-auth-helper-test-'));
  const socketPath = path.join(runtime, 'helper.sock');
  const server = childProcess.spawn(process.execPath, ['--experimental-wasm-modules', fixture, '--fixture'], {
    cwd: root,
    env: {
      ...process.env,
      PROTON_AUTH_HELPER_SOCKET: socketPath,
      PROTON_AUTH_FIXTURE: '1',
      PROTON_AUTH_FIXTURE_TIME: '59',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    server.kill('SIGTERM');
    fs.rmSync(runtime, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`fixture readiness timeout: ${stderr}`)), 10000);
    server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    server.once('exit', (code) => reject(new Error(`fixture exited ${code}: ${stderr}`)));
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('"ready":true')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

  const snapshot = runClient(socketPath, ['snapshot']);
  assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
  const payload = JSON.parse(snapshot.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.coreVersion, '0.28.8');
  assert.equal(payload.entries.length, 2);
  const totp = payload.entries.find((entry) => entry.id === 'fixture-rfc6238');
  assert.equal(totp.code, '94287082');
  assert.equal(totp.nextCode, '37359152');
  assert.equal(totp.validUntil, 60);
  const steam = payload.entries.find((entry) => entry.id === 'fixture-steam');
  assert.equal(steam.type, 'Steam');
  assert.equal(steam.code, 'PV9M4');
  assert.equal(steam.nextCode, 'B26KJ');
  assert.equal(steam.validUntil, 60);

  const copied = runClient(socketPath, ['copy', 'fixture-rfc6238']);
  assert.equal(copied.status, 0);
  assert.equal(JSON.parse(copied.stdout).copied, true);

  const rejected = runClient(socketPath, ['copy', '../bad']);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).ok, false);

  const locked = runClient(socketPath, ['lock']);
  assert.equal(locked.status, 0);
  assert.equal(JSON.parse(locked.stdout).locked, true);
  const afterLock = runClient(socketPath, ['snapshot']);
  assert.equal(afterLock.status, 0);
  assert.equal(JSON.parse(afterLock.stdout).state, 'locked');
  assert.deepEqual(JSON.parse(afterLock.stdout).entries, []);
  const copyWhileLocked = runClient(socketPath, ['copy', 'fixture-rfc6238']);
  assert.equal(copyWhileLocked.status, 1);

  // The socket has no release path: `unlock` was removed from the helper and
  // from the client's allowed ops, so it cannot even be dialled.
  const unlocked = runClient(socketPath, ['unlock']);
  assert.equal(unlocked.status, 1);
  const unlockPayload = JSON.parse(unlocked.stdout);
  assert.equal(unlockPayload.ok, false);
  assert.match(unlockPayload.error, /unsupported operation/);
  // The lock is still latched: nothing about the refusal released it.
  const afterAttempt = runClient(socketPath, ['snapshot']);
  assert.equal(JSON.parse(afterAttempt.stdout).state, 'locked');
});

test('an expired helper snapshot degrades to stale and refuses to copy', async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-auth-stale-test-'));
  const socketPath = path.join(runtime, 'helper.sock');
  const server = childProcess.spawn(process.execPath, ['--experimental-wasm-modules', fixture, '--fixture'], {
    cwd: root,
    env: {
      ...process.env,
      PROTON_AUTH_HELPER_SOCKET: socketPath,
      PROTON_AUTH_FIXTURE: '1',
      PROTON_AUTH_FIXTURE_TIME: '59',
      PROTON_AUTH_FIXTURE_STALE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    server.kill('SIGTERM');
    fs.rmSync(runtime, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`fixture readiness timeout: ${stderr}`)), 10000);
    server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    server.once('exit', (code) => reject(new Error(`fixture exited ${code}: ${stderr}`)));
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('"ready":true')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  // A stale `ready` snapshot must arrive as `unavailable` with no rows, so no
  // expired code can reach the panel.
  const snapshot = runClient(socketPath, ['snapshot']);
  assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
  const payload = JSON.parse(snapshot.stdout);
  assert.equal(payload.stale, true);
  assert.equal(payload.state, 'unavailable');
  assert.deepEqual(payload.entries, []);

  const view = Model.parseHelperSnapshot(snapshot.stdout);
  assert.equal(Model.isPaused(view), true);
  assert.deepEqual(view.entries, []);
  assert.equal(Model.statusMessage({
    checked: true, available: view.ok, paused: Model.isPaused(view), state: view.state
  }), 'Codes paused · waiting for the helper');

  // Copy is refused with the distinct stale error, not a generic failure.
  const copied = runClient(socketPath, ['copy', 'fixture-rfc6238']);
  assert.equal(copied.status, 1);
  assert.equal(JSON.parse(copied.stdout).error, 'stale');
  const result = Model.parseCopyResponse(copied.stdout);
  assert.equal(result.stale, true);
  assert.equal(result.ok, false);
  assert.equal(Model.copyStatusMessage(result), 'Codes paused · waiting for the helper');
});

test('the client refuses a hijacked socket path before sending a request', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-auth-hijack-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  // A real, correctly-moded socket that answers with forged rows. The attack
  // is the path, not the server: the client must never reach this handshake.
  const evilDir = path.join(base, 'evil');
  fs.mkdirSync(evilDir, { mode: 0o700 });
  const evilSocket = path.join(evilDir, 'helper.sock');
  const forged = { v: 1, ok: true, state: 'ready', locked: false, synced: true,
    account: 'attacker@evil.test', generation: 999999, now: 59, entries: [] };
  const evil = net.createServer((client) => {
    client.on('data', (chunk) => {
      const id = JSON.parse(chunk.toString().split('\n')[0]).id;
      client.end(JSON.stringify({ ...forged, id }) + '\n');
    });
  });
  await new Promise((resolve) => evil.listen(evilSocket, resolve));
  fs.chmodSync(evilSocket, 0o600);
  t.after(() => evil.close());

  // Control: the forged server does answer when reached directly.
  const direct = await runClientAsync(evilSocket, ['snapshot']);
  assert.equal(direct.status, 0);
  assert.equal(JSON.parse(direct.stdout).account, 'attacker@evil.test');

  // Case A: symlinked runtime directory pointing at the attacker directory.
  const linkedDir = path.join(base, 'linked');
  fs.symlinkSync(evilDir, linkedDir);
  const viaLinkedDir = await runClientAsync(path.join(linkedDir, 'helper.sock'), ['snapshot']);
  assert.equal(viaLinkedDir.status, 1);
  const linkedError = JSON.parse(viaLinkedDir.stdout);
  assert.equal(linkedError.ok, false);
  assert.match(linkedError.error, /not a directory/);
  assert.doesNotMatch(viaLinkedDir.stdout, /attacker@evil\.test|999999/);

  // Case B: symlinked socket inside an otherwise valid owner-private directory.
  const goodDir = path.join(base, 'good');
  fs.mkdirSync(goodDir, { mode: 0o700 });
  const linkedSocket = path.join(goodDir, 'helper.sock');
  fs.symlinkSync(evilSocket, linkedSocket);
  const viaLinkedSocket = await runClientAsync(linkedSocket, ['snapshot']);
  assert.equal(viaLinkedSocket.status, 1);
  assert.match(JSON.parse(viaLinkedSocket.stdout).error, /not a socket/);
  assert.doesNotMatch(viaLinkedSocket.stdout, /attacker@evil\.test|999999/);

  // Case C: a world-readable parent directory is refused.
  const looseDir = path.join(base, 'loose');
  fs.mkdirSync(looseDir, { mode: 0o755 });
  const looseSocket = path.join(looseDir, 'helper.sock');
  const loose = net.createServer(() => {});
  await new Promise((resolve) => loose.listen(looseSocket, resolve));
  fs.chmodSync(looseSocket, 0o600);
  t.after(() => loose.close());
  const viaLoose = await runClientAsync(looseSocket, ['snapshot']);
  assert.equal(viaLoose.status, 1);
  assert.match(JSON.parse(viaLoose.stdout).error, /not owner-private/);

  // Case D: a group/other-readable socket is refused.
  const openSocket = path.join(goodDir, 'open.sock');
  const open = net.createServer(() => {});
  await new Promise((resolve) => open.listen(openSocket, resolve));
  fs.chmodSync(openSocket, 0o660);
  t.after(() => open.close());
  const viaOpen = await runClientAsync(openSocket, ['snapshot']);
  assert.equal(viaOpen.status, 1);
  assert.match(JSON.parse(viaOpen.stdout).error, /socket is not owner-private/);

  // Case E: a plain file at the socket path is refused.
  const plainFile = path.join(goodDir, 'plain.sock');
  fs.writeFileSync(plainFile, '', { mode: 0o600 });
  const viaFile = await runClientAsync(plainFile, ['snapshot']);
  assert.equal(viaFile.status, 1);
  assert.match(JSON.parse(viaFile.stdout).error, /not a socket/);
});

test('the client bounds the whole exchange, not each recv', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-auth-slow-test-'));
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const slowSocket = path.join(base, 'helper.sock');

  // Drips one byte every 500 ms and never sends a newline: each recv succeeds
  // well inside the per-recv timeout, so only a wall-clock deadline stops it.
  const timers = [];
  const slow = net.createServer((client) => {
    client.on('error', () => {});
    client.on('data', () => {
      for (let i = 0; i < 60; i++) {
        timers.push(setTimeout(() => { try { client.write('x'); } catch {} }, 500 * (i + 1)));
      }
    });
  });
  await new Promise((resolve) => slow.listen(slowSocket, resolve));
  fs.chmodSync(slowSocket, 0o600);
  t.after(() => { timers.forEach(clearTimeout); slow.close(); });

  const started = Date.now();
  const result = await runClientAsync(slowSocket, ['snapshot']);
  const elapsed = (Date.now() - started) / 1000;
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /timeout/);
  assert.ok(elapsed < 8, `expected a bounded exchange, took ${elapsed}s`);
});

test('the test fixture server never ships inside the helper tree', () => {
  assert.equal(fs.existsSync(path.join(root, 'helper', 'fixture-server.mjs')), false);
  assert.equal(fs.existsSync(fixture), true);
  const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\/tests export-ignore$/m);
  const source = fs.readFileSync(fixture, 'utf8');
  assert.match(source, /requires --fixture/);
  assert.match(source, /PROTON_AUTH_FIXTURE !== '1'/);
  assert.match(source, /NODE_ENV === 'production'/);
  assert.match(source, /installed plugin tree/);
});
