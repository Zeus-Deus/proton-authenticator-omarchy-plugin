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
    stale: false,
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

test('shouldAcceptGeneration keeps a latch floor and rejects forged counters', () => {
  assert.equal(M.shouldAcceptGeneration(5, 4), false);
  assert.equal(M.shouldAcceptGeneration(5, 5), true);
  // A forged high generation must not be able to wedge the floor forever.
  assert.equal(M.shouldAcceptGeneration(5, M.MAX_GENERATION + 1), false);
  assert.equal(M.shouldAcceptGeneration(5, 2 ** 53), false);
  assert.equal(M.clampGeneration(-1), 0);
  assert.equal(M.clampGeneration(M.MAX_GENERATION + 10), M.MAX_GENERATION);
  assert.equal(M.clampGeneration(7), 7);
  // The floor is a max, so a close/open cycle cannot lower it.
  assert.equal(M.latchFloor(9, 3), 9);
  assert.equal(M.latchFloor(3, 9), 9);
  assert.equal(M.latchFloor(0, 0), 0);
});

test('parseHelperSnapshot carries the helper staleness flag through', () => {
  // The helper degrades an expired `ready` snapshot to `unavailable` with no
  // rows and stale:true; the panel must be able to tell that apart from a
  // helper that is genuinely gone.
  const stale = M.parseHelperSnapshot(JSON.stringify({
    v: 1, ok: true, state: 'unavailable', locked: false, stale: true,
    synced: true, account: 'user@example.test', generation: 12, now: 100, entries: []
  }));
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.state, 'unavailable');
  assert.deepEqual(stale.entries, []);
  assert.equal(M.isPaused(stale), true);

  // Absent, non-boolean, and false stale fields are all not-stale.
  const fresh = M.parseHelperSnapshot(JSON.stringify({
    v: 1, ok: true, state: 'ready', locked: false, synced: false,
    account: '', generation: 3, now: 100, entries: []
  }));
  assert.equal(fresh.stale, false);
  assert.equal(M.isPaused(fresh), false);
  assert.equal(M.parseHelperSnapshot(JSON.stringify({
    v: 1, ok: true, state: 'unavailable', stale: 'yes', generation: 1, now: 1, entries: []
  })).stale, false);

  // A transport failure is unavailable but not paused: the helper is absent,
  // not merely behind, and the two must not show the same message.
  const gone = M.parseHelperSnapshot('');
  assert.equal(gone.ok, false);
  assert.equal(gone.stale, false);
  assert.equal(M.isPaused(gone), false);
  // A locked snapshot claiming staleness is still locked, not paused.
  assert.equal(M.isPaused({ ok: true, stale: true, state: 'locked' }), false);
});

test('parseCopyResponse distinguishes a stale refusal from a real failure', () => {
  const ok = M.parseCopyResponse('{"v":1,"ok":true,"copied":true,"generation":4}');
  assert.deepEqual(ok, { ok: true, stale: false, error: '' });
  assert.equal(M.copyStatusMessage(ok), 'Code copied');

  const stale = M.parseCopyResponse('{"v":1,"ok":false,"error":"stale"}');
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(M.copyStatusMessage(stale), 'Codes paused · waiting for the helper');

  const locked = M.parseCopyResponse('{"v":1,"ok":false,"error":"locked"}');
  assert.equal(locked.stale, false);
  assert.equal(M.copyStatusMessage(locked), 'Could not copy code');

  // The removed op and malformed output must never read as stale or as success.
  const unsupported = M.parseCopyResponse('{"v":1,"ok":false,"error":"unsupported_operation"}');
  assert.deepEqual(unsupported, { ok: false, stale: false, error: 'unsupported_operation' });
  assert.equal(M.parseCopyResponse('not json').ok, false);
  assert.equal(M.parseCopyResponse('').stale, false);
  // A wrong protocol version is not a success even when it claims one.
  assert.equal(M.parseCopyResponse('{"v":2,"ok":true,"copied":true}').ok, false);
});

test('panel wording separates panel-local hiding from a cleared helper copy', () => {
  const base = { checked: true, available: true, state: 'ready', entryCount: 2 };
  assert.equal(M.statusMessage(Object.assign({}, base, { synced: true })), '2 codes · synced');
  assert.equal(M.statusMessage(Object.assign({}, base, { entryCount: 1 })), '1 code · local');
  assert.equal(M.statusMessage({ checked: false }), 'Connecting to secure helper…');
  assert.equal(M.statusMessage({ checked: true, available: false }), 'Secure helper unavailable');

  // Hiding is local: it must not claim the helper dropped anything.
  const hidden = M.statusMessage(Object.assign({}, base, { hidden: true }));
  assert.equal(hidden, 'Codes hidden in this panel');
  assert.match(M.hintMessage({ hidden: true }), /this panel only/);
  assert.match(M.hintMessage({ hidden: true }), /helper still holds the codes/);

  // Paused reads as transient, and never as an unavailable helper.
  assert.equal(M.statusMessage(Object.assign({}, base, { state: 'unavailable', paused: true })),
    'Codes paused · waiting for the helper');
  assert.match(M.hintMessage({ paused: true }), /publishes again/);

  // The helper-side lock is the one that really cleared the codes.
  assert.equal(M.statusMessage(Object.assign({}, base, { state: 'locked', locked: true })),
    'Helper copy cleared');
  assert.match(M.hintMessage({ locked: true }), /cleared its copy/);
  assert.match(M.hintMessage({ state: 'needs_login' }), /Sign in through the pinned Proton helper/);

  // Hidden outranks every other state: a hidden panel shows nothing else.
  assert.equal(M.statusMessage({ checked: true, hidden: true, available: false, paused: true }),
    'Codes hidden in this panel');
  // Status text is sanitized like every other helper-sourced string.
  assert.equal(M.statusMessage({ checked: true, available: false, error: 'bad\u202Etext' }), 'badtext');
});
