const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../Model.js');

test('sanitizeText removes controls, bidi overrides, and zero-width spoofing', () => {
  const value = 'Proton\nAccount\u202Eabc\u200B';
  const out = M.sanitizeText(value);
  assert.equal(out, 'Proton Accountabc');
});

test('safeBinaryPath accepts absolute executable paths only', () => {
  assert.equal(M.safeBinaryPath('/home/user/.local/bin/proton-authenticator'), '/home/user/.local/bin/proton-authenticator');
  assert.equal(M.safeBinaryPath('proton-authenticator'), '');
  assert.equal(M.safeBinaryPath('/tmp/a\n--evil'), '');
  assert.equal(M.safeBinaryPath(''), '');
});

test('parseClients finds the official Proton Authenticator window', () => {
  const clients = JSON.stringify([
    { address: '0xabc12', class: 'foot', title: 'Terminal' },
    { address: '0xA0B1', class: 'me.proton.authenticator', title: 'Proton Authenticator' },
  ]);
  assert.deepEqual(M.parseClients(clients), {
    running: true,
    address: '0xA0B1',
    title: 'Proton Authenticator',
  });
});

test('parseClients accepts the official AppImage window class observed on Hyprland', () => {
  const clients = JSON.stringify([
    { address: '0xC0FFEE', class: 'Proton-authenticator', title: 'Proton Authenticator' },
  ]);
  assert.deepEqual(M.parseClients(clients), {
    running: true,
    address: '0xC0FFEE',
    title: 'Proton Authenticator',
  });
});

test('parseClients rejects title-only window spoofing', () => {
  const clients = JSON.stringify([
    { address: '0xBAD', class: 'attacker-window', title: 'Proton Authenticator' },
  ]);
  assert.deepEqual(M.parseClients(clients), { running: false, address: '', title: '' });
});

test('parseClients fails closed on malformed or oversized data', () => {
  assert.deepEqual(M.parseClients('not json'), { running: false, address: '', title: '' });
  assert.deepEqual(M.parseClients('x'.repeat(M.MAX_RESPONSE_BYTES + 1)), { running: false, address: '', title: '' });
});

test('parseClients rejects a spoofed address even when the title matches', () => {
  const clients = JSON.stringify([{ address: '$(touch /tmp/pwned)', class: 'x', title: 'Proton Authenticator' }]);
  assert.deepEqual(M.parseClients(clients), { running: false, address: '', title: '' });
});

test('launchArgs executes the discovered binary directly and optionally applies the documented GPU workaround', () => {
  assert.deepEqual(M.launchArgs('/opt/ProtonAuthenticator.AppImage', false), ['/opt/ProtonAuthenticator.AppImage']);
  assert.deepEqual(M.launchArgs('/opt/ProtonAuthenticator.AppImage', true), [
    'env',
    'WEBKIT_DISABLE_DMABUF_RENDERER=1',
    '/opt/ProtonAuthenticator.AppImage',
  ]);
  assert.deepEqual(M.launchArgs('relative', false), []);
});

test('focusArgs accepts only a Hyprland hexadecimal window address', () => {
  assert.deepEqual(M.focusArgs('0xAb12'), ['hyprctl', 'dispatch', 'focuswindow', 'address:0xAb12']);
  assert.deepEqual(M.focusArgs('title:.*'), []);
});

test('heroMeta reports dependency and running states without claiming vault access', () => {
  assert.equal(M.heroMeta({ checked: false }), 'Looking for the official app…');
  assert.equal(M.heroMeta({ checked: true, installed: false }), 'Official app not installed');
  assert.equal(M.heroMeta({ checked: true, installed: true, running: false }), 'Ready — codes stay inside Proton');
  assert.equal(M.heroMeta({ checked: true, installed: true, running: true }), 'Authenticator is open');
  assert.equal(M.heroMeta({ checked: true, installed: true, error: 'boom' }), 'boom');
});
