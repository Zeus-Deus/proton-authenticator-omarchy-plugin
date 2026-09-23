# Developing the Proton Authenticator plugin

Read this first if you are changing the plugin, on any machine, as a person or
an agent. It lists every moving part, why it exists, and which change needs
which release.

## Current state

Released and listed on the Omarchy plugin marketplace. The panel, the patched
helper, the helper build, and a real-account sign-in and phone sync have been
verified end to end. Any change to login, sync, or copy still needs a
real-account check before it ships.

## The moving parts

| Part | Where | Why it exists |
|---|---|---|
| The plugin (panel) | this repository | What users install. QML + a small Python socket client. |
| The helper patch | branch `omarchy-authenticator-helper` in `Zeus-Deus/WebClients` (a fork of `ProtonMail/WebClients`) | Proton's Linux app has no API, so the helper is Proton's own app plus one patch that adds a private local socket. The branch is the reviewable history of that patch. |
| The helper recipe | `packaging/helper/` | A `PKGBUILD` that builds Proton's pinned release tarball with `omarchy-helper.patch` (exported from the branch above), plus the systemd unit, the Hyprland window rule, and the install hook. |
| The pins | `helper/proton-helper.lock.json` | Proton version and commit, tarball and patch SHA-256, patched-tree commit, and the SHA-256 of every recipe file. |
| The installer | `scripts/setup-helper.sh` | Run by the panel's Install/Update button in Omarchy's floating terminal. Checks the recipe against the pins, builds it with `makepkg`, installs it with `pacman -U`. |
| Release watch | `.github/workflows/proton-release-watch.yml` | Free GitHub Action, daily. Opens an issue when Proton publishes a new Linux version. It changes nothing else. |
| Marketplace listing | issue in `omacom/omarchy-plugin-marketplace` | The listing is bound to one reviewed commit of this repository. |

### Why the helper is not an AUR package

It was, briefly. The marketplace review rejected that: an AUR package can
change after the plugin is reviewed, so `omarchy update` could install code no
reviewer saw. Now the helper is built only from the recipe inside the
installed plugin checkout, and its package name,
`proton-authenticator-omarchy-helper@local`, contains `@`, which AUR names
cannot, so no AUR package can replace it. **Do not publish the helper to the
AUR again**, and do not add any path that fetches a mutable recipe (AUR, a
branch name, `latest`). The earlier AUR package
`proton-authenticator-omarchy-helper` is retired; the panel offers to switch
any machine that still has it.

## Which change needs what

| You changed… | Do this |
|---|---|
| Only panel files (`*.qml`, `Model.js`, `scripts/helper_client.py`, docs) | Gates, commit, push, then request marketplace verification (below). No helper rebuild. |
| The helper patch, or Proton released a new version | The full procedure in [Updating the helper](#updating-the-helper). Users then see **Update secure helper** in the panel after they update the plugin. |
| Only the systemd unit, window rule, or install hook | Bump `pkgrel` in the `PKGBUILD`, update `package.version` and `recipe` in the lock file, build and install locally, then as for panel changes. |

Pushing to `main` does not change the marketplace listing by itself: the
catalog keeps the approved commit and shows *Update unverified* until a new
commit is approved. To publish one, bump `version` in `manifest.json`, tag it,
push, and open the marketplace's **Plugin verification** form with *Verify and
publish a newer upstream commit* and the full 40-character SHA. Do not push
while a marketplace review of an earlier commit is still open; the review is
bound to that commit.

## Architecture

- `Panel.qml`: popup, type-to-search, countdown, code display, setup phases and
  their one primary action, opaque-ID actions.
- `Service.qml`: bounded helper client processes and the two `systemctl --user`
  unit actions; no UI. `helperCommit` is the patched-tree commit this plugin
  expects; a running helper built from another commit makes the panel offer
  **Update secure helper**.
- `Model.js`: pure response validation, `setupPhase`/`primaryAction`, filter and
  countdown helpers. No Qt imports; Node-tested.
- `scripts/helper_client.py`: bounded Unix-socket client, plus `probe` (local
  install/unit facts, never the socket).
- `scripts/setup-helper.sh`: install/update/migrate from the pinned recipe.
- `tests/fixtures/fixture-server.mjs`: test-only RFC fixture using Proton's
  official `@protontech/authenticator-rust-core` package.

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
9. The helper is built only from the pinned recipe in this repository. Every
   remote input is pinned by full commit or SHA-256, and every recipe file by
   SHA-256 in the lock file.
10. Test with made-up demo codes. Screenshots for the README or marketplace must
    never show a real account.

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
omarchy-shell proton-authenticator status   # helperSourceCommit must equal pinnedHelperCommit
```

Helper side, in a WebClients checkout on the `omarchy-authenticator-helper`
branch:

```bash
cd applications/authenticator/src-tauri && cargo test --locked --lib
```

## Updating the helper

The release watch opens an issue when Proton publishes a new version. To
update:

1. Fetch Proton's `release/proton-authenticator@<new>` branch and read the diff
   from the current base, especially `src-tauri/`, `src/lib/`, and storage
   migrations.
2. Rebase `omarchy-authenticator-helper` onto the new release-branch head.
   Resolve conflicts; keep the patch additive. Push the branch to the fork.
3. `cargo test --locked --lib`; bump `HELPER_PATCH_REVISION` only if the patch
   itself changed.
4. Regenerate the patch:
   `git diff --binary <new-base> HEAD > packaging/helper/omarchy-helper.patch`.
5. Update `packaging/helper/PKGBUILD` (`_protonver`, `_protoncommit`,
   `_patchcommit`, `_patchrev`, `sha256sums`, reset `pkgrel=1`), the lock file
   (version, commits, hashes, `package.version`, and the `recipe` SHA-256 of
   every file in `packaging/helper/`), and `helperCommit` in `Service.qml`.
   `tests/qml_contract.test.js` fails if any of them disagree.
6. Run `scripts/setup-helper.sh update` from this checkout: it must verify the
   recipe, build, pass the `PKGBUILD` `check()`, and install.
7. Confirm `omarchy-shell proton-authenticator status` reports the new
   `helperVersion` and `helperSourceCommit`, and that codes still publish and
   copy.
8. Commit, push, and request marketplace verification (above).

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
- The helper's windows are hidden from screenshots by design
  (`no_screen_share`). For documentation shots:
  `omarchy-toggle proton-authenticator-screen-share on && hyprctl reload`,
  reopen the window, then turn it off again.
