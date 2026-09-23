# Proton Authenticator for Omarchy Quattro

Your Proton Authenticator codes in the Omarchy bar: search, see the current and
next code, copy with Enter. Add, edit, and manage codes in Proton's own window,
opened from the panel. Codes sync with Proton Authenticator on your phone.

> Independent community integration. Not affiliated with or endorsed by Proton
> AG or Omarchy. “Proton” and “Proton Authenticator” identify the compatible
> service and upstream open-source client.

## How it works

There are three parts. You install one of them; the panel installs the second
with one button; the third is your existing Proton account.

1. **This plugin** (MIT) — the panel. It shows code rows it receives from the
   helper and sends back only an opaque row ID when you copy. It never sees
   your password, your keys, or your secrets.
2. **The helper** (GPL-3, AUR package `proton-authenticator-omarchy-helper`) —
   Proton's own Authenticator app, built from Proton's official source for the
   release, running hidden in the background as a hardened user service. It
   does the sign-in, encryption, sync, code generation, and clipboard.
3. **Your Proton account** — the same end-to-end encrypted sync your phone
   uses. Nothing goes anywhere else.

### First run

1. Install the plugin from Setup → Plugins (or `omarchy plugin add`).
2. Open the panel. It says *Secure helper not installed*; press **Install
   secure helper**. Omarchy's floating terminal opens and builds the helper
   from Proton's source through the AUR (a few minutes; you type your sudo
   password into that terminal). The helper starts when it finishes.
3. Press **Sign in with Proton**. Proton's own sign-in window opens, floating
   in the middle of the screen like Omarchy's other password managers: email,
   password, and your Proton 2FA or security key, exactly as on your phone. It
   is Proton's hosted sign-in page; the panel never sees any of it.
4. Your codes sync in and appear in the panel. The helper keeps running
   hidden.

Proton's windows float, center, and are hidden from screen sharing through a
window rule the package installs in Omarchy's `default/hypr/apps/`.

### Updates

The helper is an ordinary AUR package, so **`omarchy update` updates it** like
everything else. A running helper switches to the new version by itself the
next time Proton's window is closed; the panel shows *Update installed ·
restart pending* until then, with a button to do it now. Your sign-in and codes
are kept across updates.

When Proton releases a new version of Authenticator, a scheduled check in this
repository opens an issue; the package is rebuilt against Proton's new source,
re-tested, and published to the AUR. See [Updating the pinned Proton
release](docs/DEVELOPMENT.md#updating-the-pinned-proton-release).

### Managing codes

- **Copy:** Enter or `c` on a row (the helper clears it from the clipboard
  after 20 seconds).
- **Add a code:** `a` or **Add code** — opens Proton's add-code dialog (manual
  entry or a QR image).
- **Edit, delete, reorder, import, export, backups, settings, sign out:** `m`
  or **Manage in Proton** — opens Proton's full app window.

All management is Proton's own UI, so it works exactly as on your phone, and
changes sync to your other devices.

## Why a patched helper

Proton's Linux app has no command line, no API, and no local socket, so no
other program can get codes out of it. The only way to show codes in a panel
with the unmodified app would be to decrypt its database from outside — i.e.
reimplement Proton's crypto inside the shell — which is worse on every axis.

So the helper is Proton's official 1.1.6 source for the release
(`release/proton-authenticator@1.1.6`, commit `0deabe38`) with **one patch file**,
[`packaging/aur/omarchy-helper.patch`](packaging/aur/omarchy-helper.patch)
(about 2,600 added lines, nearly all in new files). It:

- adds a private Unix socket (`0700` directory, `0600` socket, peer-UID check)
  that serves the current code rows and copies a code by ID;
- adds a hidden background mode, and an `open` request that shows Proton's own
  window (sign-in, add code, manage);
- adds a watchdog that reloads a stalled web view and restarts onto an upgraded
  binary;
- turns off Proton's in-app updater on Linux, because updates come from the
  package (this also stops the launch-time version check to proton.me);
- adds `libc` (for the peer-UID check) and bumps `tauri-plugin-log` from 2.8.0
  to 2.9.0; those are the only dependency changes, and the removed
  `Cargo.lock` lines are transitive dependencies 2.9.0 no longer pulls in;
- adds a build check that refuses an artifact carrying Proton's QA hooks,
  devtools, or source maps.

It does **not** change Proton's login, key handling, encryption, or sync code.
The patch is shipped inside the package at
`/usr/share/doc/proton-authenticator-omarchy-helper/omarchy-helper.patch`, and
the patched tree is reviewable at
[`Zeus-Deus/WebClients`](https://github.com/Zeus-Deus/WebClients), branch
`omarchy-authenticator-helper`.

The helper replaces Proton's own Linux app on the same machine: they share one
app identifier, data folder, keyring entry, and D-Bus name, so they cannot run
together. The installer offers to remove Proton's app if it finds it; your
codes and sign-in are kept.

## Keys

- `/` search · `j`/`k` select · Enter or `c` copy · `r` refresh
- `a` add code · `m` manage in Proton
- `L` hide or show rows **in this panel only** (the helper keeps its copy)
- `x` clear the helper's copy of every code (asks first, defaults to Cancel).
  Codes stay hidden everywhere until you press **Restart helper** in the panel.

## Security

What stays where:

- Your Proton password, 2FA, keys, and TOTP secrets never reach the panel,
  argv, environment variables, logs, notifications, or the shell's IPC.
- The panel receives only display rows (issuer, name, current and next code)
  while it is open, and drops them when it closes.
- Codes you see in the panel live in the `omarchy-shell` process, so
  screenshots, screen sharing, and shell crash dumps can capture them.
- The helper socket authenticates your Unix user, not one application: any
  program running as you can ask it for codes, as it could read Proton's own
  app data. This is not a defence against malware running as your user.

Full detail: [SECURITY.md](SECURITY.md).

## Status

Tested: the full panel ↔ helper protocol, RFC 6238 and Steam codes from
Proton's official Rust core, clipboard ownership and expiry, the sandboxed
service, the AUR package build from Proton's release tarball, and install /
start / restart / update states.

Not yet tested with a real Proton account: sign-in, sync with a phone, and
login challenges (CAPTCHA, security keys). The sign-in is Proton's unmodified
UI, but it has not been exercised end to end here yet.

Runtime requirements: Omarchy Quattro on Wayland, a user systemd session, and
`wl-clipboard`.

## Removal

```bash
systemctl --user disable --now proton-authenticator-omarchy-helper.service
omarchy pkg drop proton-authenticator-omarchy-helper
omarchy plugin remove io.github.zeus-deus.proton-authenticator
```

Removing the package leaves Proton's data folder
(`~/.local/share/me.proton.authenticator`) in place, so Proton's own app can
take over the same sign-in. Delete it to remove every local trace; your codes
remain on your Proton account.

## Licensing

The plugin and protocol client are MIT. The helper and the patch are GPL-3,
like Proton's Authenticator. No Proton artwork or binaries are in this
repository.
