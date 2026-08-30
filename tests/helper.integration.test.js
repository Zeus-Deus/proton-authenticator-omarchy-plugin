const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const fixture = path.join(root, 'helper', 'fixture-server.mjs');
const client = path.join(root, 'scripts', 'helper_client.py');

function runClient(socketPath, args) {
  return childProcess.spawnSync('python3', [client, ...args], {
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
  assert.equal(payload.coreVersion, '2.0.0');
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].code, '94287082');
  assert.equal(payload.entries[0].nextCode, '37359152');
  assert.equal(payload.entries[0].validUntil, 60);

  const copied = runClient(socketPath, ['copy', 'fixture-rfc6238']);
  assert.equal(copied.status, 0);
  assert.equal(JSON.parse(copied.stdout).copied, true);

  const rejected = runClient(socketPath, ['copy', '../bad']);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).ok, false);
});
