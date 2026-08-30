# Proton Authenticator Companion — Agent Guide

## Architecture

- `Panel.qml`: Quattro UI, cursor/keyboard handling, IPC, no secret access.
- `Service.qml`: executable/window detection and safe launch/focus only.
- `Model.js`: all pure parsing, validation and argv builders; Node-testable.
- `scripts/install_official_appimage.py`: prompting, signed, user-local installer.
- `tests/`: Node model tests and Python installer/crypto tests.

## Hard rules

1. Never read Proton Authenticator's local database, browser profile, keyring,
   auth/session state, logs, or clipboard.
2. Never implement or reverse-engineer Proton account login/sync in this plugin.
3. Never display or generate codes in `omarchy-shell`; launch the protected app.
4. Secrets never enter argv, environment variables, shell config, logs, or QML.
5. External data is bounded, sanitized, and parsed fail-closed.
6. Commands use argv arrays. The one shell command is a fixed literal for PATH
   resolution and may not receive interpolated values.
7. The AppImage installer must verify both minisign signatures before install,
   remain user-local, visible, prompting, and non-updating.
8. No Proton artwork is bundled. The generic shield/key glyph avoids implying
   endorsement or importing third-party assets.

## Gates

```bash
node --test tests/model.test.js tests/qml_contract.test.js
python3 -m unittest tests/test_installer.py -v
qmllint -I /usr/share/omarchy/shell Service.qml AuthenticatorIcon.qml
omarchy plugin validate .
omarchy-restart-shell
qs log -p /usr/share/omarchy/shell --tail 60
omarchy-shell proton-authenticator-companion status
```

`Panel.qml` exits 255 without diagnostics in standalone `qmllint` because the
linter cannot resolve Omarchy's injected `qs.Ui`/`qs.Commons` types. Validate it
with `omarchy plugin validate`, a real shell restart, IPC status, and shell logs.
Panel QML edits require `omarchy-restart-shell`.

## Manual acceptance

- Missing state offers a visible, confirmation-default-No installer.
- Installed/stopped state launches the official app.
- Running state focuses the existing window without starting a duplicate.
- Right-click bar icon launches/focuses directly.
- The optional DMA-BUF setting passes only Proton's documented env flag.
- Closing the panel stops status polling.
- No Proton password/code is needed for tests; use the real signed app logged out.
