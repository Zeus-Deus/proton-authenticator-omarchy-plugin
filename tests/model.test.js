const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../Model.js');

test('sanitizeText removes controls, bidi overrides, and zero-width spoofing', () => {
  const value = 'Proton\nAccount\u061C\u200E\u200F\u202Eabc\u200B\u2060';
  const out = M.sanitizeText(value);
  assert.equal(out, 'Proton Accountabc');
  assert.ok(Buffer.byteLength(M.sanitizeText('ü'.repeat(80), 80), 'utf8') <= 80);
});


test('parseHelperSnapshot accepts bounded official-core code rows', () => {
  const raw = JSON.stringify({
    v: 1,
    id: 'request',
    ok: true,
    state: 'ready',
    locked: false,
    synced: true,
    account: 'user@example.test',
    generation: 7,
    now: 59,
    entries: [{
      id: 'fixture-rfc6238',
      name: 'test',
      issuer: 'RFC6238',
      type: 'Totp',
      code: '94287082',
      nextCode: '37359152',
      period: 30,
      validUntil: 60,
    }],
  });
  assert.deepEqual(M.parseHelperSnapshot(raw), {
    ok: true,
    state: 'ready',
    locked: false,
    synced: true,
    account: 'user@example.test',
    generation: 7,
    now: 59,
    entries: [{
      id: 'fixture-rfc6238',
      name: 'test',
      issuer: 'RFC6238',
      type: 'Totp',
      code: '94287082',
      nextCode: '37359152',
      period: 30,
      validUntil: 60,
    }],
    error: '',
  });
});

test('parseHelperSnapshot rejects malformed codes, ids, and oversized responses', () => {
  const malicious = JSON.stringify({
    v: 1, ok: true, state: 'ready', now: 1,
    entries: [
      { id: '../bad', name: 'bad', issuer: 'x', type: 'Totp', code: '123456', nextCode: '654321', period: 30, validUntil: 30 },
      { id: 'good', name: 'bad code', issuer: 'x', type: 'Totp', code: '12 3456', nextCode: '654321', period: 30, validUntil: 30 },
    ],
  });
  assert.deepEqual(M.parseHelperSnapshot(malicious).entries, []);
  assert.equal(M.parseHelperSnapshot('x'.repeat(M.MAX_HELPER_BYTES + 1)).ok, false);
});

test('shouldAcceptGeneration rejects snapshots older than the privacy latch', () => {
  assert.equal(M.shouldAcceptGeneration(8, 7), false);
  assert.equal(M.shouldAcceptGeneration(8, 8), true);
  assert.equal(M.shouldAcceptGeneration(8, 9), true);
  assert.equal(M.shouldAcceptGeneration(0, -1), false);
});

test('filterEntries searches sanitized issuer/name and remainingSeconds clamps', () => {
  const entries = [
    { id: '1', name: 'Alex', issuer: 'GitHub' },
    { id: '2', name: 'Work', issuer: 'Proton' },
  ];
  assert.deepEqual(M.filterEntries(entries, 'git').map((row) => row.id), ['1']);
  assert.deepEqual(M.filterEntries(entries, 'alex').map((row) => row.id), ['1']);
  assert.equal(M.remainingSeconds(60, 59), 1);
  assert.equal(M.remainingSeconds(60, 61), 0);
});
