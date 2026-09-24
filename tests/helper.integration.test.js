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
  return childProcess.spawnSync('/usr/bin/python3', [client, '--allow-socket-override', ...args], {
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
    const child = childProcess.spawn('/usr/bin/python3', [client, '--allow-socket-override', ...args], {
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
    checked: true, available: view.ok, paused: Model.isPaused(view), state: view.state, api: view.api
  }), 'Codes paused · waiting for the helper');
  assert.equal(Model.setupPhase({ available: view.ok, paused: Model.isPaused(view), state: view.state, api: view.api }), 'paused');

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

test('the socket override is refused unless the caller opts in explicitly', () => {
  // The plugin never passes --allow-socket-override, so in production an
  // environment variable cannot redirect the client to another socket, even one
  // that would pass the ownership checks.
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-auth-override-'));
  fs.chmodSync(runtime, 0o700);
  const socketPath = path.join(runtime, 'helper.sock');
  const result = childProcess.spawnSync('/usr/bin/python3', [client, 'status'], {
    cwd: root,
    env: { ...process.env, PROTON_AUTH_HELPER_SOCKET: socketPath },
    encoding: 'utf8',
    timeout: 5000,
  });
  fs.rmSync(runtime, { recursive: true, force: true });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'helper socket override rejected');
});

test('client errors are fixed identifiers, never raw exception text or paths', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-auth-errors-'));
  fs.chmodSync(runtime, 0o700);
  const socketPath = path.join(runtime, 'helper.sock');
  const missing = runClient(socketPath, ['status']);
  assert.equal(JSON.parse(missing.stdout).error, 'helper socket is unavailable');
  assert.doesNotMatch(missing.stdout, new RegExp(runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const usage = runClient(socketPath, []);
  assert.equal(usage.status, 2);
  assert.equal(JSON.parse(usage.stdout).error, 'usage');
  const badOp = runClient(socketPath, ['unlock']);
  assert.equal(JSON.parse(badOp.stdout).error, 'unsupported operation');
  const badId = runClient(socketPath, ['copy', '../etc']);
  assert.equal(JSON.parse(badId.stdout).error, 'invalid item id');
  fs.rmSync(runtime, { recursive: true, force: true });
});

test('a restarted helper reports a new instance so the panel floor can reset', async (t) => {
  const start = (instanceId) => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-auth-instance-'));
    const socketPath = path.join(runtime, 'helper.sock');
    const server = childProcess.spawn(process.execPath, ['--experimental-wasm-modules', fixture, '--fixture'], {
      cwd: root,
      env: {
        ...process.env,
        PROTON_AUTH_HELPER_SOCKET: socketPath,
        PROTON_AUTH_FIXTURE: '1',
        PROTON_AUTH_FIXTURE_TIME: '59',
        PROTON_AUTH_FIXTURE_INSTANCE: instanceId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      server.kill('SIGTERM');
      fs.rmSync(runtime, { recursive: true, force: true });
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture readiness timeout')), 10000);
      server.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('"ready":true')) { clearTimeout(timer); resolve(); }
      });
      server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`fixture exited ${code}`)); });
    });
    return { socketPath, ready };
  };

  const M = require('../Model.js');
  const first = start('a'.repeat(32));
  await first.ready;
  // Lock the first "process" so the panel floor rises above its generation.
  const lock = M.parseLockResponse(runClient(first.socketPath, ['lock']).stdout);
  assert.equal(lock.ok, true);
  assert.equal(lock.instance, 'a'.repeat(32));
  let panel = M.nextLatchState('', 0, lock.instance, lock.generation);
  const replay = M.parseHelperSnapshot(JSON.stringify({
    v: 1, ok: true, state: 'ready', generation: 1, instance: lock.instance, now: 59, entries: [],
  }));
  assert.equal(M.acceptsSnapshot(panel.instance, panel.floor, replay.instance, replay.generation), false,
    'a pre-lock generation from the same process stays rejected');

  // The helper restarts: a different instance with generation back at 1.
  const second = start('b'.repeat(32));
  await second.ready;
  const fresh = M.parseHelperSnapshot(runClient(second.socketPath, ['snapshot']).stdout);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.state, 'ready');
  assert.equal(fresh.instance, 'b'.repeat(32));
  assert.ok(fresh.generation <= panel.floor, 'the new process counts from the start again');
  assert.equal(M.acceptsSnapshot(panel.instance, panel.floor, fresh.instance, fresh.generation), true,
    'the first snapshot from the new process is accepted');
  panel = M.nextLatchState(panel.instance, panel.floor, fresh.instance, fresh.generation);
  assert.equal(panel.reset, true);
  assert.equal(panel.instance, 'b'.repeat(32));
  assert.equal(panel.floor, fresh.generation);
});

async function startFixture(t, extraEnv = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-auth-open-test-'));
  const socketPath = path.join(runtime, 'helper.sock');
  const server = childProcess.spawn(process.execPath, ['--experimental-wasm-modules', fixture, '--fixture'], {
    cwd: root,
    env: {
      ...process.env,
      PROTON_AUTH_HELPER_SOCKET: socketPath,
      PROTON_AUTH_FIXTURE: '1',
      PROTON_AUTH_FIXTURE_TIME: '59',
      ...extraEnv,
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
  return socketPath;
}

test('open surfaces only allow-listed Proton views and never touches codes or the lock', async (t) => {
  const socketPath = await startFixture(t);
  for (const view of ['manage', 'login', 'add']) {
    const opened = runClient(socketPath, ['open', view]);
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    const payload = JSON.parse(opened.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.views.at(-1), view);
    // No code material in an open response.
    assert.doesNotMatch(opened.stdout, /entries|"code"|nextCode/);
  }
  // Unknown views, missing views, and option-looking views are refused by the
  // client before any socket traffic, with a fixed error identifier.
  for (const args of [['open', 'settings'], ['open'], ['open', '--login'], ['open', 'login', 'extra']]) {
    const refused = runClient(socketPath, args);
    assert.notEqual(refused.status, 0, args.join(' '));
    const body = JSON.parse(refused.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /^(invalid view|usage)$/);
  }
  // Opening a window did not release or engage anything.
  const lock = runClient(socketPath, ['lock']);
  assert.equal(JSON.parse(lock.stdout).locked, true);
  runClient(socketPath, ['open', 'manage']);
  const after = JSON.parse(runClient(socketPath, ['snapshot']).stdout);
  assert.equal(after.state, 'locked');
  assert.equal(after.latched, true);
  assert.deepEqual(after.entries, []);
  const view = Model.parseHelperSnapshot(JSON.stringify(after));
  assert.equal(Model.setupPhase({ available: true, api: view.api, latched: view.latched, locked: view.locked, state: view.state }), 'locked');
});

test('an older helper still serves codes but the panel asks for an update', async (t) => {
  const socketPath = await startFixture(t, { PROTON_AUTH_FIXTURE_API: '1' });
  const snapshot = runClient(socketPath, ['snapshot']);
  const view = Model.parseHelperSnapshot(snapshot.stdout);
  assert.equal(view.ok, true);
  assert.equal(view.entries.length, 2);
  assert.equal(view.api, 0);
  assert.equal(Model.setupPhase({ available: true, api: view.api, state: view.state }), 'update');
  // The api-1 helper has no `open` op; the refusal is a fixed identifier.
  const opened = runClient(socketPath, ['open', 'login']);
  assert.equal(opened.status, 1);
  assert.equal(Model.publicError(JSON.parse(opened.stdout).error), 'Secure helper rejected the request');
});

test('a helper whose binary was upgraded asks for a restart while still serving codes', async (t) => {
  const socketPath = await startFixture(t, { PROTON_AUTH_FIXTURE_REPLACED: '1' });
  const view = Model.parseHelperSnapshot(runClient(socketPath, ['snapshot']).stdout);
  assert.equal(view.binaryReplaced, true);
  assert.equal(view.entries.length, 2);
  assert.equal(view.helperVersion, '1.1.6+omarchy.1');
  assert.equal(Model.setupPhase({ available: true, api: view.api, binaryReplaced: true, state: view.state }), 'restart');
});

test('probe reports local setup facts without contacting any socket', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-auth-probe-'));
  try {
    const run = () => childProcess.spawnSync('/usr/bin/python3', [client, 'probe'], {
      env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: path.join(home, 'no-runtime') },
      encoding: 'utf8',
      timeout: 5000,
    });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    let probe = Model.parseProbe(result.stdout);
    assert.equal(probe.ok, true);
    assert.match(probe.unit, /^(active|activating|inactive|failed|deactivating|unknown)$/);
    // Files the user manages under the same names are not the plugin's
    // business: they change nothing in the probe.
    fs.mkdirSync(path.join(home, '.config', 'systemd', 'user'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', 'proton-authenticator-omarchy-helper.service'), '');
    assert.deepEqual(Model.parseProbe(run().stdout), probe);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
