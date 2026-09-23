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
    instance: '',
    sourceCommit: '',
    api: 0,
    helperVersion: '',
    latched: false,
    binaryReplaced: false,
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
  assert.deepEqual(unsupported, { ok: false, stale: false, error: 'Secure helper rejected the request' });
  assert.equal(M.parseCopyResponse('not json').ok, false);
  assert.equal(M.parseCopyResponse('').stale, false);
  // A wrong protocol version is not a success even when it claims one.
  assert.equal(M.parseCopyResponse('{"v":2,"ok":true,"copied":true}').ok, false);
});

test('panel wording separates panel-local hiding from a cleared helper copy', () => {
  const base = { checked: true, available: true, state: 'ready', entryCount: 2, api: M.REQUIRED_HELPER_API };
  assert.equal(M.statusMessage(Object.assign({}, base, { synced: true })), '2 codes · synced');
  assert.equal(M.statusMessage(Object.assign({}, base, { entryCount: 1 })), '1 code · local');
  assert.equal(M.statusMessage({ checked: false }), 'Connecting to secure helper…');
  assert.equal(M.statusMessage({ checked: true, available: false, probe: { ok: true, installed: true, unit: 'active' } }), 'Secure helper unavailable');

  // Hiding is local: it must not claim the helper dropped anything.
  const hidden = M.statusMessage(Object.assign({}, base, { hidden: true }));
  assert.equal(hidden, 'Codes hidden in this panel');
  assert.match(M.hintMessage({ hidden: true }), /this panel only/);
  assert.match(M.hintMessage({ hidden: true }), /helper still holds the codes/);

  // Paused reads as transient, and never as an unavailable helper.
  assert.equal(M.statusMessage(Object.assign({}, base, { state: 'unavailable', paused: true })),
    'Codes paused · waiting for the helper');
  assert.match(M.hintMessage(Object.assign({}, base, { state: 'unavailable', paused: true })), /publishes again/);

  // The helper-side latch is the one that really cleared the codes; Proton's
  // own app lock (PIN/password) is a different state with a different fix.
  assert.equal(M.statusMessage(Object.assign({}, base, { state: 'locked', locked: true, latched: true })),
    'Helper copy cleared');
  assert.match(M.hintMessage(Object.assign({}, base, { latched: true })), /cleared its copy/);
  assert.equal(M.statusMessage(Object.assign({}, base, { state: 'locked', locked: true })),
    "Locked by Proton's app lock");
  assert.match(M.hintMessage(Object.assign({}, base, { locked: true })), /Unlock it in Proton's window/);
  assert.match(M.hintMessage(Object.assign({}, base, { state: 'needs_login' })), /Sign in once in Proton's own window/);

  // Hidden outranks every other state: a hidden panel shows nothing else.
  assert.equal(M.statusMessage({ checked: true, hidden: true, available: false, paused: true }),
    'Codes hidden in this panel');
  // Error text is never free-form: an unknown identifier (or raw exception
  // text) collapses to a fixed message, known identifiers map to fixed prose.
  assert.equal(M.statusMessage({ checked: true, available: false, error: 'bad\u202Etext' }), 'Secure helper unavailable');
  assert.equal(M.statusMessage({ checked: true, available: false, error: 'maximum recursion depth exceeded while decoding a JSON array' }), 'Secure helper unavailable');
  assert.equal(M.statusMessage({ checked: true, available: false, error: 'helper socket has a foreign owner' }), 'Secure helper socket failed its safety check');
  assert.equal(M.statusMessage({ checked: true, available: false, error: 'helper response timeout' }), 'Secure helper did not respond');
  // Recovery is a panel button now, not a command the user has to type.
  assert.match(M.hintMessage(Object.assign({}, base, { latched: true })), /Restarting it brings them back/);
  assert.match(M.LOCK_CONFIRM_MESSAGE, /restart the helper from this panel/);
  assert.equal(M.primaryAction(M.setupPhase(Object.assign({}, base, { latched: true }))).id, 'restart');
});

test('the latch floor resets only when the helper reports a different instance', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);

  // First contact: adopt the instance and its generation.
  assert.deepEqual(M.nextLatchState('', 0, A, 5), { instance: A, floor: 5, reset: false });
  // Same instance: monotonic floor, never decreases.
  assert.deepEqual(M.nextLatchState(A, 5, A, 3), { instance: A, floor: 5, reset: false });
  assert.deepEqual(M.nextLatchState(A, 5, A, 9), { instance: A, floor: 9, reset: false });
  // The helper restarted: generations start over and so does the floor.
  assert.deepEqual(M.nextLatchState(A, 3600, B, 1), { instance: B, floor: 1, reset: true });
  // No instance in the response: keep the old floor exactly as before.
  assert.deepEqual(M.nextLatchState(A, 3600, '', 1), { instance: A, floor: 3600, reset: false });
  assert.deepEqual(M.nextLatchState('', 3600, '', 1), { instance: '', floor: 3600, reset: false });
  // A forged instance value that is not lowercase hex is treated as absent.
  assert.deepEqual(M.nextLatchState(A, 3600, 'not hex!', 1), { instance: A, floor: 3600, reset: false });

  // Acceptance mirrors the same rules. The scenario from the audit: lock at
  // generation 3600, helper restarts, first snapshot is generation 1.
  assert.equal(M.acceptsSnapshot(A, 3600, A, 1), false, 'replay against the same process stays rejected');
  assert.equal(M.acceptsSnapshot(A, 3600, B, 1), true, 'a new process is accepted immediately');
  assert.equal(M.acceptsSnapshot(A, 3600, '', 1), false, 'an instance-less response cannot reset the floor');
  assert.equal(M.acceptsSnapshot('', 0, A, 1), true);
  assert.equal(M.acceptsSnapshot(A, 5, A, 5), true);
  // A forged out-of-range generation is still rejected on a known instance.
  assert.equal(M.acceptsSnapshot(A, 5, A, M.MAX_GENERATION + 1), false);
});

test('instance identifiers and lock responses are validated before use', () => {
  assert.equal(M.safeInstance('0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(M.safeInstance('ABCDEF'), '');
  assert.equal(M.safeInstance('../x'), '');
  assert.equal(M.safeInstance(''), '');
  assert.equal(M.safeInstance(null), '');
  assert.equal(M.safeInstance('f'.repeat(65)), '');

  const inst = 'c'.repeat(32);
  const lock = M.parseLockResponse(JSON.stringify({ v: 1, ok: true, locked: true, generation: 12, instance: inst }));
  assert.deepEqual(lock, { ok: true, generation: 12, instance: inst });
  assert.deepEqual(M.parseLockResponse('{"v":1,"ok":true,"locked":false,"generation":12}'), { ok: false, generation: 0, instance: '' });
  assert.deepEqual(M.parseLockResponse('{"v":1,"ok":false,"error":"unsupported_operation"}'), { ok: false, generation: 0, instance: '' });
  assert.deepEqual(M.parseLockResponse('garbage'), { ok: false, generation: 0, instance: '' });

  const snap = M.parseHelperSnapshot(JSON.stringify({ v: 1, ok: true, state: 'ready', generation: 1, instance: inst, now: 1, entries: [] }));
  assert.equal(snap.instance, inst);

  const commit = 'd'.repeat(40);
  assert.equal(M.safeSourceCommit(commit), commit);
  assert.equal(M.safeSourceCommit(commit + '-dirty'), commit + '-dirty');
  assert.equal(M.safeSourceCommit('unknown'), 'unknown');
  assert.equal(M.safeSourceCommit('<script>'), '');
  assert.equal(M.safeSourceCommit(commit.toUpperCase()), '');
  const withCommit = M.parseHelperSnapshot(JSON.stringify({ v: 1, ok: true, state: 'ready', generation: 1, sourceCommit: commit, now: 1, entries: [] }));
  assert.equal(withCommit.sourceCommit, commit);
});

test('rows whose window already closed by the helper clock are dropped', () => {
  const row = (validUntil) => ({
    id: 'x', name: 'n', issuer: 'i', type: 'Totp', code: '123456', nextCode: '654321', period: 30, validUntil,
  });
  const at = (now, rows) => M.parseHelperSnapshot(JSON.stringify({ v: 1, ok: true, state: 'ready', generation: 1, now, entries: rows }));
  assert.equal(at(59, [row(60)]).entries.length, 1, 'one second left is current');
  assert.equal(at(59, [row(60)]).entries[0].code, '123456');
  // Within one window of the rollover the next code is promoted, so the row
  // does not vanish until the next publication.
  const rolled = at(60, [row(60)]).entries;
  assert.equal(rolled.length, 1, 'validUntil == now rolls forward');
  assert.equal(rolled[0].code, '654321');
  assert.equal(rolled[0].nextCode, '');
  assert.equal(rolled[0].validUntil, 90);
  assert.equal(at(89, [row(60)]).entries[0].code, '654321');
  assert.equal(at(90, [row(60)]).entries.length, 0, 'more than one window old is dropped');
  const noNext = { ...row(60), nextCode: '' };
  assert.equal(at(59, [noNext]).entries.length, 1, 'a helper-rolled row without a next code is current');
  assert.equal(at(60, [noNext]).entries.length, 0, 'and cannot roll again');
  assert.equal(at(59, [{ ...row(60), nextCode: '12' }]).entries.length, 0, 'a malformed next code still rejects the row');
  // A snapshot without a clock keeps the previous behaviour.
  assert.equal(at(0, [row(60)]).entries.length, 1);
});

test('entriesEqual detects identical row sets so the panel can keep its delegates', () => {
  const rows = () => [
    { id: 'a', name: 'A', issuer: 'I', type: 'Totp', code: '111111', nextCode: '222222', period: 30, validUntil: 60 },
    { id: 'b', name: 'B', issuer: 'J', type: 'Steam', code: 'PV9M4', nextCode: 'B26KJ', period: 30, validUntil: 60 },
  ];
  assert.equal(M.entriesEqual(rows(), rows()), true);
  assert.equal(M.entriesEqual(rows(), rows().slice(0, 1)), false);
  const changedCode = rows(); changedCode[0].code = '999999';
  assert.equal(M.entriesEqual(rows(), changedCode), false);
  const changedWindow = rows(); changedWindow[1].validUntil = 90;
  assert.equal(M.entriesEqual(rows(), changedWindow), false);
  const reordered = rows().reverse();
  assert.equal(M.entriesEqual(rows(), reordered), false);
  assert.equal(M.entriesEqual([], []), true);
  assert.equal(M.entriesEqual(null, []), true);
});

test('sanitizeText strips the remaining invisible and filler code points', () => {
  const probes = [
    '\u2800', '\u034F', '\uFFF9', '\uFFFA', '\uFFFB', '\uFFFC', '\u17B4', '\u17B5',
    '\uD834\uDD73', '\uD834\uDD7A',           // U+1D173..U+1D17A musical format controls
    '\uDB40\uDD00', '\uDB40\uDDEF',           // U+E0100..U+E01EF variation selectors
  ];
  for (const probe of probes) {
    assert.equal(M.sanitizeText(`Git${probe}Hub`), 'GitHub', JSON.stringify(probe));
  }
  // Legitimate text is untouched.
  assert.equal(M.sanitizeText('Zürich Bank · Konto'), 'Zürich Bank · Konto');
});

test('setupPhase maps every helper situation to exactly one next step', () => {
  const api = M.REQUIRED_HELPER_API;
  const probe = (p) => Object.assign({ ok: true, installed: true, unit: 'inactive', legacy: false, conflict: false }, p);
  const phase = (v) => M.setupPhase(v);
  // Socket down: the local probe decides.
  assert.equal(phase({ available: false, probe: probe({ installed: false }) }), 'install');
  assert.equal(phase({ available: false, probe: probe({ installed: false, conflict: true }) }), 'install');
  assert.equal(phase({ available: false, probe: probe({ conflict: true }) }), 'install');
  assert.equal(phase({ available: false, probe: probe({ installed: false, legacy: true }) }), 'migrate');
  // A leftover development unit in ~/.config shadows the packaged one.
  assert.equal(phase({ available: false, probe: probe({ legacy: true }) }), 'migrate');
  assert.equal(phase({ available: false, probe: probe({ unit: 'inactive' }) }), 'start');
  assert.equal(phase({ available: false, probe: probe({ unit: 'failed' }) }), 'start');
  assert.equal(phase({ available: false, probe: probe({ unit: 'active' }) }), 'starting');
  assert.equal(phase({ available: false, probe: { ok: false } }), 'starting');
  assert.equal(phase({ available: false }), 'starting');
  // Socket up.
  const up = { available: true, api, state: 'ready' };
  assert.equal(phase(up), 'ready');
  assert.equal(phase(Object.assign({}, up, { api: 1 })), 'update');
  assert.equal(phase(Object.assign({}, up, { api: undefined })), 'update');
  // An old helper answering: the files on disk decide the fix.
  assert.equal(phase(Object.assign({}, up, { api: 0, probe: probe({ legacy: true }) })), 'migrate');
  assert.equal(phase(Object.assign({}, up, { api: 0, probe: probe({ unit: 'active' }) })), 'restart');
  assert.equal(phase(Object.assign({}, up, { api: 0, probe: probe({ installed: false }) })), 'update');
  assert.equal(phase(Object.assign({}, up, { api: 0, probe: { ok: false } })), 'update');
  // The header agrees with the button for an old helper.
  assert.equal(M.statusMessage(Object.assign({ checked: true }, up, { api: 0, probe: probe({ legacy: true }) })), 'Development helper running');
  assert.equal(M.statusMessage(Object.assign({ checked: true }, up, { api: 0, probe: probe({ unit: 'active' }) })), 'Update installed · restart pending');
  assert.equal(M.statusMessage(Object.assign({ checked: true }, up, { api: 0, probe: probe({ installed: false }) })), 'Secure helper needs an update');
  assert.equal(phase(Object.assign({}, up, { binaryReplaced: true })), 'restart');
  // A helper built from a different commit than this plugin pins: rebuild.
  const pin = 'a'.repeat(40);
  assert.equal(phase(Object.assign({}, up, { pinnedCommit: pin, sourceCommit: 'b'.repeat(40) })), 'update');
  assert.equal(phase(Object.assign({}, up, { pinnedCommit: pin, sourceCommit: pin })), 'ready');
  // Unknown or malformed commits never force a rebuild.
  for (const odd of ['', 'unknown', `${'b'.repeat(40)}-dirty`, 'rm -rf', undefined])
    assert.equal(phase(Object.assign({}, up, { pinnedCommit: pin, sourceCommit: odd })), 'ready', String(odd));
  // An earlier AUR build: switch to the reviewed recipe's build.
  assert.equal(phase(Object.assign({}, up, { pinnedCommit: pin, sourceCommit: pin, probe: probe({ aurBuild: true }) })), 'migrate');
  assert.equal(M.primaryAction('migrate').id, 'install');
  assert.equal(phase(Object.assign({}, up, { latched: true, locked: true, state: 'locked' })), 'locked');
  // The latch outranks an outdated helper: its recovery (restart) comes first.
  assert.equal(phase(Object.assign({}, up, { latched: true, api: 1 })), 'locked');
  assert.equal(phase(Object.assign({}, up, { locked: true, state: 'locked' })), 'applock');
  assert.equal(phase(Object.assign({}, up, { state: 'needs_login' })), 'signin');
  assert.equal(phase(Object.assign({}, up, { paused: true, state: 'unavailable' })), 'paused');
  assert.equal(phase(Object.assign({}, up, { hidden: true })), 'hidden');
  assert.equal(phase({ hidden: true, available: false }), 'hidden');

  const actions = {
    install: 'install', migrate: 'install', update: 'install', start: 'start', restart: 'restart',
    locked: 'restart', applock: 'manage', signin: 'login', paused: 'refresh', hidden: 'show',
    starting: 'refresh', ready: ''
  };
  for (const [p, id] of Object.entries(actions)) {
    const action = M.primaryAction(p);
    assert.equal(action.id, id, p);
    assert.equal(action.label === '', id === '', p);
  }
});

test('parseProbe accepts only the fixed probe shape', () => {
  assert.deepEqual(M.parseProbe('{"v":1,"ok":true,"installed":true,"unit":"active","legacy":false,"conflict":false}'),
    { ok: true, installed: true, unit: 'active', legacy: false, conflict: false, aurBuild: false });
  assert.equal(M.parseProbe('{"v":1,"ok":true,"installed":true,"unit":"active","legacy":false,"conflict":false,"aurBuild":true}').aurBuild, true);
  // Unknown unit states and non-boolean flags collapse to safe values.
  assert.deepEqual(M.parseProbe('{"v":1,"ok":true,"installed":"yes","unit":"rm -rf","legacy":1,"conflict":null}'),
    { ok: true, installed: false, unit: 'unknown', legacy: false, conflict: false, aurBuild: false });
  for (const bad of ['', 'nope', '{"v":2,"ok":true}', '{"v":1,"ok":false}', '[]'])
    assert.equal(M.parseProbe(bad).ok, false, bad);
});

test('a forged out-of-range generation rejects the whole response instead of clamping', () => {
  const row = { id: 'a', name: 'n', issuer: 'i', type: 'Totp', code: '123456', nextCode: '654321', period: 30, validUntil: 30 };
  const base = { v: 1, ok: true, state: 'ready', now: 1, instance: 'ab', entries: [row] };
  // (JSON cannot carry Infinity; it arrives as null, i.e. no generation.)
  for (const generation of [M.MAX_GENERATION + 1, 2 ** 53, -1, 'NaN', '1e400']) {
    const parsed = M.parseHelperSnapshot(JSON.stringify(Object.assign({}, base, { generation })));
    assert.equal(parsed.ok, false, String(generation));
    assert.deepEqual(parsed.entries, []);
    assert.equal(M.parseLockResponse(JSON.stringify({ v: 1, ok: true, locked: true, generation, instance: 'ab' })).ok, false);
  }
  assert.equal(M.parseHelperSnapshot(JSON.stringify(Object.assign({}, base, { generation: M.MAX_GENERATION }))).ok, true);
});

test('helper version and api fields are validated before display', () => {
  const base = { v: 1, ok: true, state: 'ready', now: 1, generation: 1, entries: [] };
  const good = M.parseHelperSnapshot(JSON.stringify(Object.assign({}, base, {
    api: 2, helperVersion: '1.1.6+omarchy.1', latched: false, binaryReplaced: true
  })));
  assert.equal(good.api, 2);
  assert.equal(good.helperVersion, '1.1.6+omarchy.1');
  assert.equal(good.binaryReplaced, true);
  const bad = M.parseHelperSnapshot(JSON.stringify(Object.assign({}, base, {
    api: '9999', helperVersion: '1.1.6\u202Eevil', latched: 'true', binaryReplaced: 1
  })));
  assert.equal(bad.api, 255);
  assert.equal(bad.helperVersion, '');
  assert.equal(bad.latched, false);
  assert.equal(bad.binaryReplaced, false);
});

test('wheelScroll steps a fixed distance per notch and clamps to the content', () => {
  // A mouse notch down (angle -120) moves one step; up moves back.
  assert.equal(M.wheelScroll(0, 1000, 400, 0, -120, 84), 84);
  assert.equal(M.wheelScroll(84, 1000, 400, 0, 120, 84), 0);
  // A touchpad pixel delta passes through 1:1.
  assert.equal(M.wheelScroll(100, 1000, 400, -30, -120, 84), 130);
  // Clamped at both ends; content shorter than the view never scrolls.
  assert.equal(M.wheelScroll(590, 1000, 400, 0, -120, 84), 600);
  assert.equal(M.wheelScroll(10, 1000, 400, 0, 240, 84), 0);
  assert.equal(M.wheelScroll(0, 300, 400, 0, -120, 84), 0);
  assert.equal(M.wheelScroll('x', undefined, null, NaN, 0, 84), 0);
});

test('filterEntries is a fuzzy, ranked search over issuer and account', () => {
  const rows = [['GitHub', 'octo'], ['Proton', 'me@proton.me'], ['Google', 'me@gmail.com'],
    ['Amazon Web Services', 'root'], ['Cloudflare', 'me@example.com'], ['Gitea', 'home']]
    .map(([issuer, name], i) => ({ id: String(i), issuer, name }));
  const q = (query) => M.filterEntries(rows, query).map((row) => row.issuer);
  assert.deepEqual(q('gh'), ['GitHub']);
  assert.deepEqual(q('aws'), ['Amazon Web Services']);
  assert.deepEqual(q('git'), ['GitHub', 'Gitea']);
  assert.deepEqual(q('cf'), ['Cloudflare']);
  assert.deepEqual(q('gmail'), ['Google'], 'the account name is searched too');
  assert.deepEqual(q('me ex'), ['Cloudflare'], 'every term must match');
  assert.deepEqual(q('zzz'), []);
  assert.deepEqual(q('  '), rows.map((row) => row.issuer), 'blank shows everything in Proton order');
  assert.deepEqual(q('\u202Egit'), ['GitHub', 'Gitea'], 'the query is sanitized');
});

test('formatCode groups digits for display only', () => {
  assert.equal(M.formatCode('284913'), '284 913');
  assert.equal(M.formatCode('94287082'), '9428 7082');
  assert.equal(M.formatCode('PV9M4'), 'PV9M4');
  assert.equal(M.formatCode(''), '');
  assert.equal(M.matchCountLabel(0), 'no matches');
  assert.equal(M.matchCountLabel(1), '1 match');
  assert.equal(M.matchCountLabel(4), '4 matches');
});
