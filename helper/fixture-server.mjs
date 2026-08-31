#!/usr/bin/env node
/** Test-only helper implementing the production line-delimited JSON protocol.
 * Code generation comes from Proton's pinned official Rust/WASM core. This
 * server must never be installed or launched by the production plugin.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  entry_from_uri,
  generate_code,
  library_version,
  new_steam_entry_from_params,
} from '@protontech/authenticator-rust-core/worker/proton_authenticator_web.js';

if (!process.argv.includes('--fixture')) throw new Error('fixture server requires --fixture');

const MAX_REQUEST_BYTES = 16 * 1024;
const fixedTime = BigInt(process.env.PROTON_AUTH_FIXTURE_TIME || '59');
const socketPath = process.env.PROTON_AUTH_HELPER_SOCKET || path.join(os.tmpdir(), `proton-auth-fixture-${process.pid}.sock`);
const runtimeDir = path.dirname(socketPath);
const totpEntry = entry_from_uri(
  'otpauth://totp/RFC6238:test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=RFC6238&algorithm=SHA1&digits=8&period=30'
);
totpEntry.id = 'fixture-rfc6238';
const steamEntry = new_steam_entry_from_params({
  name: 'Steam RFC fixture',
  secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  note: undefined,
});
steamEntry.id = 'fixture-steam';
const fixtureEntries = [totpEntry, steamEntry];
let generation = 1;
let isLocked = false;

fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
fs.chmodSync(runtimeDir, 0o700);
try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }

function response(id, body) {
  return JSON.stringify({ v: 1, id, ...body }) + '\n';
}

function snapshot(id) {
  if (isLocked) {
    return response(id, {
      ok: true,
      state: 'locked',
      locked: true,
      synced: false,
      account: 'RFC fixture',
      generation,
      now: Number(fixedTime),
      coreVersion: library_version(),
      entries: [],
    });
  }
  const now = Number(fixedTime);
  const entries = fixtureEntries.map((entry) => {
    const codes = generate_code(entry, fixedTime);
    const period = Number(entry.period || 30);
    return {
      id: entry.id,
      name: entry.name,
      issuer: entry.issuer,
      type: entry.entry_type,
      code: codes.current_code,
      nextCode: codes.next_code,
      period,
      validUntil: now - (now % period) + period,
    };
  });
  return response(id, {
    ok: true,
    state: 'ready',
    locked: false,
    synced: false,
    account: 'RFC fixture',
    generation,
    now,
    coreVersion: library_version(),
    entries,
  });
}

function handle(request) {
  const id = typeof request.id === 'string' ? request.id.slice(0, 64) : '';
  if (request.v !== 1 || !id) return response(id, { ok: false, error: 'invalid_request' });
  if (request.op === 'status' || request.op === 'snapshot') return snapshot(id);
  if (request.op === 'copy') {
    if (isLocked) return response(id, { ok: false, error: 'locked', generation });
    if (!fixtureEntries.some((entry) => request.itemId === entry.id)) return response(id, { ok: false, error: 'not_found' });
    return response(id, { ok: true, copied: true, generation });
  }
  if (request.op === 'lock') {
    isLocked = true;
    generation++;
    return response(id, { ok: true, state: 'locked', locked: true, generation });
  }
  if (request.op === 'unlock') {
    isLocked = false;
    generation++;
    return response(id, { ok: true, state: 'ready', locked: false, generation });
  }
  return response(id, { ok: false, error: 'unsupported_operation' });
}

const server = net.createServer((client) => {
  let data = Buffer.alloc(0);
  client.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]);
    if (data.length > MAX_REQUEST_BYTES) return client.destroy();
    const newline = data.indexOf(10);
    if (newline < 0) return;
    try {
      const request = JSON.parse(data.subarray(0, newline).toString('utf8'));
      client.end(handle(request));
    } catch {
      client.end(response('', { ok: false, error: 'invalid_json' }));
    }
  });
});

function cleanup() {
  try { fs.unlinkSync(socketPath); } catch {}
}
process.on('SIGTERM', () => server.close(() => { cleanup(); process.exit(0); }));
process.on('SIGINT', () => server.close(() => { cleanup(); process.exit(0); }));
process.on('exit', cleanup);
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  console.log(JSON.stringify({ ready: true, socket: socketPath, pid: process.pid }));
});
