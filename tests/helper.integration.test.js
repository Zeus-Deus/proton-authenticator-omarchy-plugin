const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

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

  const unlocked = runClient(socketPath, ['unlock']);
  assert.equal(unlocked.status, 0);
  assert.equal(JSON.parse(unlocked.stdout).locked, false);
  const afterUnlock = runClient(socketPath, ['snapshot']);
  assert.equal(afterUnlock.status, 0);
  assert.equal(JSON.parse(afterUnlock.stdout).state, 'ready');
  assert.equal(JSON.parse(afterUnlock.stdout).entries.length, 2);
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
