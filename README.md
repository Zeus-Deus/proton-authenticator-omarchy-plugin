# Proton Authenticator for Omarchy Quattro

A panel-native Omarchy bar widget for searching, viewing, and copying Proton
Authenticator codes.

> Independent community integration. Not affiliated with or endorsed by Proton
> AG or Omarchy. “Proton” and “Proton Authenticator” identify the compatible
> service and upstream open-source client.

## Development status

This is currently a **development preview**, not a real-account release.

Completed and tested:

- Quattro popup, search, keyboard/mouse selection, current and next codes;
- bounded line-delimited JSON over a user-owned Unix socket;
- helper client with no password/token/secret/code in argv;
- copy requests by opaque item ID;
- official `@protontech/authenticator-rust-core` v2.0.0 code generation;
- all six RFC 6238 SHA-1 vectors;
- deterministic popup fixture (`94287082`, then `37359152`);
- `0700` runtime directory and `0600` socket.

Still in progress:

- the production helper patch in the pinned Proton WebClients fork;
- official Proton login, encrypted sync, lock, and clipboard integration;
- a human real-account acceptance test.

Do not use the fixture with real secrets. The plugin will not be published as a
finished authenticator until the production helper and real-account handoff pass.

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

A temporary helper window is allowed for first login/unlock. Normal use happens
inside the Quattro popup; it does not open the full Authenticator app.

## Intended use

- Left-click: open the popup.
- Type `/`: focus search.
- `j` / `k`: select a code.
- Enter or `c`: ask the helper to copy the selected code.
- `r`: refresh.
- `l`: lock and clear visible rows.
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
- Official core package: `@protontech/authenticator-rust-core@2.0.0`
- Exact source commit and npm integrity: `helper/proton-helper.lock.json`
- Proton Authenticator: https://proton.me/authenticator
- Proton Authenticator source application:
  https://github.com/ProtonMail/WebClients/tree/main/applications/authenticator

## Licensing

The Quattro plugin and protocol client are MIT. The helper fork and any Proton
Authenticator-derived code remain GPL-3 under Proton's upstream license. Proton
artwork and application binaries are not bundled in this repository.
