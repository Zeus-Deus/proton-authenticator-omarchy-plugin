# Proton Authenticator for Omarchy — Agent Guide

## Current state

Development preview. The popup and deterministic official-core fixture work;
the pinned real Proton helper is not complete and real-account support must not
be claimed.

## Architecture

- `Panel.qml`: popup, search, countdown, code display, opaque-ID actions.
- `Service.qml`: bounded helper client process only.
- `Model.js`: pure response validation/filter/countdown helpers.
- `scripts/helper_client.py`: bounded Unix-socket client.
- `helper/fixture-server.mjs`: test-only RFC fixture using Proton's official
  `@protontech/authenticator-rust-core` package.
- `helper/proton-helper.lock.json`: exact upstream commit/package integrity.
- Production helper: GPL-3 patch in `Zeus-Deus/WebClients`.

## Hard rules

1. Never put passwords, login 2FA, tokens, seeds, keys, or generated codes in
   argv, environment variables, shell settings, logs, notifications, or status
   IPC.
2. Visible codes may exist in QML memory only while the panel/helper is unlocked;
   lock/logout/socket loss clears rows immediately.
3. Copy sends an opaque item ID. The helper writes and conditionally expires the
   clipboard.
4. Production socket parent is `0700`, socket `0600`, and helper verifies peer
   UID with `SO_PEERCRED`.
5. Bound response bytes, row count, and field lengths; sanitize controls/bidi;
   discard stale generations.
6. Never install or launch `helper/fixture-server.mjs` in production.
7. Never claim real Proton login/sync works without a human real-account test.
8. Update pinned Proton source only after diff review and full regression gates.

## Gates

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

`Panel.qml` standalone lint is not authoritative because injected `qs.Ui` and
`qs.Commons` types are unresolved. Validate it in the real shell.
