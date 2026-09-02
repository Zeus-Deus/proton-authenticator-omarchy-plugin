# Proton Authenticator for Omarchy Quattro

A panel-native Omarchy bar widget for searching, viewing, and copying Proton
Authenticator codes.

> Independent community integration. Not affiliated with or endorsed by Proton
> AG or Omarchy. “Proton” and “Proton Authenticator” identify the compatible
> service and upstream open-source client.

## Development status

This is currently a **development preview**. The panel-native helper works with
local Authenticator entries, but real Proton-account login/sync still requires a
human acceptance test.

Completed and tested:

- Quattro popup, search, keyboard/mouse selection, current and next codes;
- bounded line-delimited JSON over a user-owned Unix socket;
- helper client with no password/token/secret/code in argv;
- copy requests by opaque item ID;
- exact pinned GPL helper fork builds without Tauri devtools and runs hidden;
- `0700` runtime directory, `0600` socket, and `SO_PEERCRED` UID check, plus
  client-side validation of the socket's type, owner, and mode before connecting;
- shell IPC limited to fail-safe verbs (no `unlock`, `copy`, or `login`);
- hardened helper systemd unit (`systemd-analyze security --user` 3.1 OK);
- local RFC TOTP entry flowed Proton DB → helper → Quattro popup;
- real current/next codes matched an independent RFC HMAC calculation;
- copy by opaque ID wrote the expected code; the helper's foreground clipboard
  owner expires after 20 seconds without clearing newer external clipboard data;
- deterministic official-core TOTP (`94287082`, then `37359152`) and Steam
  (`PV9M4`, then `B26KJ`) fixtures.

Still untested:

- interactive login with a real Proton account;
- account-backed encrypted sync against another Proton Authenticator device;
- login challenges such as CAPTCHA, mailbox 2FA, or extra-password prompts.

Known residual exposure, stated rather than implied:

- codes rendered in the panel live in the `omarchy-shell` process, which this
  plugin's service hardening does not cover; screenshots, screen sharing, and
  shell crash dumps can expose them;
- the helper socket and shell IPC authenticate a Unix UID, not an application,
  so any same-UID process shares that trust boundary.

Do not use the fixture with real secrets. Real-account support must not be
claimed until a user completes the interactive acceptance test.

Runtime requirements: Omarchy Quattro on Wayland, a user systemd session, and
Omarchy's `wl-clipboard` tools at `/usr/bin/wl-copy` and `/usr/bin/wl-paste`.

Do **not** install Proton's official Linux app alongside the helper. They share
the `me.proton.authenticator` identifier, data directory, keyring entry, and
single-instance D-Bus name; see [SECURITY.md](SECURITY.md#single-instance-d-bus-name).
The helper is the pinned official source plus the socket.

## Architecture

Quickshell cannot safely host Proton's web frontend: importing `QtWebEngine`
crashes the current Quickshell process before QML loads. Proton also exposes no
supported Authenticator CLI or public sync API.

The selected design therefore has two processes:

1. **Pinned Proton helper (GPL-3)** — forked from Proton's open-source
   `WebClients` Authenticator at the exact commit in
   [`helper/proton-helper.lock.json`](helper/proton-helper.lock.json). It owns
   Proton login, session/key storage, encrypted sync, TOTP/Steam generation,
   lock state, and clipboard writes.
2. **Omarchy popup (MIT)** — shows bounded current/next code rows and sends only
   opaque item IDs for copy. It never receives passwords, auth tokens, encrypted
   entry secrets, storage keys, or Proton user keys.

A temporary helper window opens directly to Proton's official Device sync modal
for first login. Normal code use stays inside the Quattro popup; hiding rows is
a panel-local control that does not open the Authenticator app.

## Intended use

- Left-click: open the popup.
- Type `/`: focus search.
- `j` / `k`: select a code.
- Enter or `c`: ask the helper to copy the selected code.
- `r`: refresh.
- `L`: hide or show code rows **in this panel only**. Hiding stops the panel
  rendering rows and stops it polling the helper; it does not ask the helper to
  forget anything, and the helper keeps its copy of the codes. (Lowercase `l` is
  reserved by Omarchy's panel key handling as a cursor movement key.)
- `x`: ask the helper to clear its published snapshot and latch itself locked.
  A confirmation opens first, defaulting to Cancel. This is one-way: the socket
  has no release operation, so the helper stays locked until the helper service
  restarts (`systemctl --user restart proton-authenticator-omarchy-helper`; the
  panel names this command while locked). The socket is owner-private (`0700`
  parent, `0600` socket, `SO_PEERCRED`), which authenticates the Unix UID — not
  one specific application. Neither control is a defence against same-UID
  malware.
- If the helper's publisher stalls, its snapshot expires after 5 seconds and the
  panel shows `Codes paused · waiting for the helper` instead of stale codes.
- Each row shows the current code, next code, and remaining seconds.

## Development verification

```bash
npm ci --prefix tests/fixtures --ignore-scripts --no-audit --no-fund
node --test tests/model.test.js tests/qml_contract.test.js tests/helper.integration.test.js
/usr/bin/python3 -m py_compile scripts/helper_client.py
qmllint -I /usr/share/omarchy/shell Service.qml AuthenticatorIcon.qml
omarchy plugin validate .
systemd-analyze security --user proton-authenticator-omarchy-helper.service
omarchy-restart-shell
qs log -p /usr/share/omarchy/shell --tail 60
omarchy-shell proton-authenticator status
```

Standalone `qmllint` exits 255 without diagnostics on `Panel.qml` because it
cannot resolve Omarchy's injected `qs.Ui` / `qs.Commons` types. The manifest
validator, real shell restart, IPC status, and shell log are the panel gate.

The `status` output includes `helperSourceCommit` (what the running helper was
built from, as it reports over the socket) and `pinnedHelperCommit` (what this
plugin expects). They must match; if they do not, the helper on disk is not the
one this repository documents. Rebuild and install it from the fork with
`yarn workspace proton-authenticator build:omarchy-helper -- --install`, which
verifies the artifact, installs it, restarts the unit, and checks the running
process.

## Pinned sources

- Proton WebClients upstream: https://github.com/ProtonMail/WebClients
- Auditable fork: https://github.com/Zeus-Deus/WebClients
- Official core package: `@protontech/authenticator-rust-core@0.28.8`
- Exact source commit and npm integrity: `helper/proton-helper.lock.json`
- Proton Authenticator: https://proton.me/authenticator
- Proton Authenticator source application:
  https://github.com/ProtonMail/WebClients/tree/main/applications/authenticator

## Licensing

The Quattro plugin and protocol client are MIT. The helper fork and any Proton
Authenticator-derived code remain GPL-3 under Proton's upstream license. Proton
artwork and application binaries are not bundled in this repository.
