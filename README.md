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
- `0700` runtime directory, `0600` socket, and `SO_PEERCRED` UID check;
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

Do not use the fixture with real secrets. Real-account support must not be
claimed until a user completes the interactive acceptance test.

Runtime requirements: Omarchy Quattro on Wayland, a user systemd session, and
Omarchy's `wl-clipboard` tools at `/usr/bin/wl-copy` and `/usr/bin/wl-paste`.

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
for first login. Normal code use and hide/show stay inside the Quattro popup; they
do not open the full Authenticator app.

## Intended use

- Left-click: open the popup.
- Type `/`: focus search.
- `j` / `k`: select a code.
- Enter or `c`: ask the helper to copy the selected code.
- `r`: refresh.
- `l`: hide or restore code rows through the owner-only helper socket.
- Each row shows the current code, next code, and remaining seconds.

## Development verification

```bash
npm ci --prefix helper --ignore-scripts --no-audit --no-fund
node --test tests/model.test.js tests/qml_contract.test.js tests/helper.integration.test.js
python3 -m py_compile scripts/helper_client.py
qmllint -I /usr/share/omarchy/shell Service.qml AuthenticatorIcon.qml
omarchy plugin validate .
omarchy-restart-shell
qs log -p /usr/share/omarchy/shell --tail 60
omarchy-shell proton-authenticator status
```

Standalone `qmllint` exits 255 without diagnostics on `Panel.qml` because it
cannot resolve Omarchy's injected `qs.Ui` / `qs.Commons` types. The manifest
validator, real shell restart, IPC status, and shell log are the panel gate.

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
