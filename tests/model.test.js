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

test('sanitizeText strips invisible, filler, and tag code points that survive \\s collapsing', () => {
  const marks = [
    '\u00AD', '\u061C', '\u180E', '\u200B', '\u200C', '\u200D', '\u200E', '\u200F',
    '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2060', '\u2061', '\u2062',
    '\u2063', '\u2064', '\u2066', '\u2067', '\u2068', '\u2069', '\uFEFF',
    '\u115F', '\u1160', '\u3164', '\uFFA0', '\uFE00', '\uFE0F',
    '\uDB40\uDC01', '\uDB40\uDC41',
  ];
  for (const mark of marks) {
    assert.equal(M.sanitizeText(`Git${mark}Hub`), 'GitHub', `not stripped: ${escape(mark)}`);
  }
  // The exact spoofing string from the audit must not survive.
  assert.equal(M.sanitizeText('GitHub\u2063\u3164\u00ad\udb40\udc41Fake'), 'GitHubFake');
  // Two rows that differ only by invisible marks must collapse to one label.
  assert.equal(M.sanitizeText('GitHub\u3164'), M.sanitizeText('GitHub'));
  // Real text is untouched.
  assert.equal(M.sanitizeText('Proton Mail · üñî 中文'), 'Proton Mail · üñî 中文');
});

test('the response cap counts UTF-8 bytes, not UTF-16 code units', () => {
  const payload = (name) => JSON.stringify({
    v: 1, ok: true, state: 'ready', generation: 1, now: 0, account: name, entries: [],
  });
  // Two-byte characters: under the UTF-16 length cap but over the byte cap.
  const oversize = payload('é'.repeat(M.MAX_HELPER_BYTES - 200));
  assert.ok(oversize.length <= M.MAX_HELPER_BYTES, 'precondition: passes a UTF-16 length check');
  assert.ok(Buffer.byteLength(oversize, 'utf8') > M.MAX_HELPER_BYTES, 'precondition: exceeds the byte cap');
  assert.equal(M.parseHelperSnapshot(oversize).ok, false);
  // An ASCII payload inside the cap still parses.
  assert.equal(M.parseHelperSnapshot(payload('user@example.test')).ok, true);
});
