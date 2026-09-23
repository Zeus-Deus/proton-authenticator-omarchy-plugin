# Developing the Proton Authenticator plugin

## Current state

Released. The panel, the patched helper, the AUR package, and a real-account
sign-in and phone sync have been verified end to end. Any change to login,
sync, or copy still needs a real-account check before it ships.

## Architecture

- `Panel.qml`: popup, type-to-search, countdown, code display, setup phases and their
  one primary action, opaque-ID actions.
- `Service.qml`: bounded helper client processes and the two `systemctl --user`
  unit actions; no UI.
- `Model.js`: pure response validation, `setupPhase`/`primaryAction`, filter and
  countdown helpers. No Qt imports; Node-tested.
- `scripts/helper_client.py`: bounded Unix-socket client, plus `probe` (local
  install/unit facts, never the socket).
- `scripts/setup-helper.sh`: install/update/migrate, run by the panel inside
  Omarchy's floating terminal.
- `tests/fixtures/fixture-server.mjs`: test-only RFC fixture using Proton's
  official `@protontech/authenticator-rust-core` package.
- `helper/proton-helper.lock.json`: Proton release, tarball and patch hashes,
  patched-tree commit, helper API level.
- `packaging/aur/`: the AUR package (`PKGBUILD`, patch, unit, install hook). The
  AUR git repo is a copy of this directory plus `.SRCINFO`.
- Patch source: branch `omarchy-authenticator-helper` in `Zeus-Deus/WebClients`,
  based on Proton's `release/proton-authenticator@<version>` branch.

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
   discard stale generations; reject out-of-range generations whole.
6. Never install or launch `tests/fixtures/fixture-server.mjs` in production.
7. Never claim a login/sync change works without a human real-account test.
8. The panel never executes the helper binary, a package manager, or sudo.
   Proton's windows open through the socket's `open` op; installs run in
   Omarchy's floating terminal where the user sees them.
9. Update the pinned Proton release only through the procedure below.

## Gates

```bash
npm ci --prefix tests/fixtures --ignore-scripts --no-audit --no-fund
node --test tests/*.test.js
/usr/bin/python3 -m py_compile scripts/helper_client.py
bash -n scripts/setup-helper.sh
/usr/lib/qt6/bin/qmllint -I <dir with qs -> /usr/share/omarchy/shell> -I /usr/lib/qt6/qml Service.qml Panel.qml
omarchy plugin validate .
omarchy-restart-shell
qs log -p /usr/share/omarchy/shell --tail 60
omarchy-shell proton-authenticator status
```

Helper side, in the WebClients checkout:

```bash
cd applications/authenticator/src-tauri && cargo test --locked --lib
cd packaging/aur && makepkg -f        # full build from Proton's tarball + patch
```

## Updating the pinned Proton release

A scheduled workflow (`.github/workflows/proton-release-watch.yml`) compares
Proton's published Linux version with `protonVersion` in the lock file daily and
opens an issue when they differ. To update:

1. Fetch Proton's `release/proton-authenticator@<new>` branch and read the diff
   from the current base, especially `src-tauri/`, `src/lib/`, and storage
   migrations.
2. Rebase `omarchy-authenticator-helper` onto the new release-branch head.
   Resolve conflicts; keep the patch additive.
3. `cargo test --locked --lib`; bump `HELPER_PATCH_REVISION` only if the patch
   itself changed.
4. Regenerate the patch:
   `git diff --binary <new-base> HEAD > packaging/aur/omarchy-helper.patch`.
5. Update `PKGBUILD` (`_protonver`, `_protoncommit`, `_patchcommit`,
   `sha256sums`, reset `pkgrel=1`), the lock file (version, commits, hashes),
   and `helperCommit` in `Service.qml`. `tests/qml_contract.test.js` fails if
   any of them disagree.
6. `makepkg -f` must build and pass its `check()`.
7. Install the package locally, confirm `omarchy-shell proton-authenticator
   status` reports the new `helperVersion` and `helperSourceCommit`, and that
   codes still publish and copy.
8. Copy `packaging/aur/*` into the AUR repo, `makepkg --printsrcinfo >
   .SRCINFO`, commit, push. Users get it with `omarchy update`.

## Traps

- `SystemCallFilter=@system-service` alone kills `WebKitWebProcess` with SIGSYS
  (`mincore`); the unit lists it explicitly. Check
  `journalctl -k | grep -i 'syscall=27'` when codes stop publishing while the
  unit is active.
- A user unit in `~/.config/systemd/user/` shadows the packaged one in
  `/usr/lib/systemd/user/`. `probe` reports it as `legacy`, and the panel
  offers the switch.
- The helper and Proton's official Linux app share one app id, data folder,
  keyring entry, and D-Bus name. Never run both.
- `Panel.qml` opens Proton's window only after closing itself, because the
  panel is a full-screen layer that would cover it.
