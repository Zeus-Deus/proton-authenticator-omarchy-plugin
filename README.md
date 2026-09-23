# Proton Authenticator for Omarchy

Your Proton Authenticator 2FA codes in the Omarchy bar. Type to search, press
Enter to copy. Codes sync with Proton Authenticator on your phone.

![The panel with demo codes, and a search for "cloud"](preview.png)

<sub>Screenshots use made-up demo accounts and codes.</sub>

> Independent community plugin. Not affiliated with or endorsed by Proton AG.
> “Proton” and “Proton Authenticator” name the service and the open-source app
> this plugin works with.

## Install

```bash
omarchy plugin add https://github.com/Zeus-Deus/proton-authenticator-omarchy-plugin.git --enable --yes
```

Or find it under Setup › Plugins. Then open the panel from the bar:

1. Press **Install secure helper**. Omarchy's floating terminal opens, you
   type your sudo password once, and it installs the helper in a few seconds
   (it asks before replacing anything).
2. Press **Sign in with Proton**. Proton's own sign-in window opens: email,
   password, and your 2FA or security key, the same as on your phone.
3. Your codes appear. That's it.

Nothing is downloaded or built when the plugin itself is installed; the helper
is only installed when you press the button. See [Dependencies](#dependencies).

## Using it

| Key | Action |
|---|---|
| *just type* | Fuzzy search by service or account (`gh` finds GitHub) |
| `Enter` | Copy the highlighted code |
| `↑` `↓` / `Ctrl+J` `Ctrl+K` | Move the selection |
| `PgUp` `PgDn` / `Home` `End` | Jump through the list |
| `Backspace` / `Ctrl+U` | Edit / clear the search |
| `Esc` | Clear the search, then close the panel |
| `Ctrl+A` | Add a code (Proton's add window: manual entry or QR image) |
| `Ctrl+O` | Open Proton to edit, delete, reorder, import, export, or sign out |
| `Ctrl+R` | Refresh |
| `Ctrl+H` | Hide or show codes in this panel |
| `Ctrl+X` | Clear the helper's copy of every code (asks first) |
| `Tab` | Next bar panel |

Letters and digits only ever search; every action uses `Ctrl`, so typing a
name never opens a window. The mouse works too: click a row to copy it, and
the **Add code** and **Open Proton** buttons sit under the list.

<img src="docs/images/copied.png" alt="A copied row" width="414">

Each row shows the current code, the next one, and the time left; the code
turns red in its last five seconds. A copied code is cleared from the clipboard
after 20 seconds and is marked sensitive, so Omarchy's clipboard history does
not keep it.

Adding, editing, and deleting codes happens in Proton's own window, so it
works exactly as on your phone and syncs to your other devices.

## Updates

`omarchy plugin update` (or Setup › Plugins) updates the plugin. When a plugin
update comes with a new helper, for example after Proton releases a new
Authenticator version, the panel shows **Update secure helper**; press it once
and the helper is rebuilt in the floating terminal. Your sign-in and codes are
kept.

The helper is deliberately **not** updated by `omarchy update` or the AUR: it
is pinned by checksum in the plugin version you installed, so it cannot change
without the plugin changing.

## Dependencies

- Omarchy (Quattro shell) on Hyprland, with `wl-clipboard` (installed by
  default).
- A Proton account with Proton Authenticator.
- The helper, which the panel installs for you (step 1 above) as the local
  package `proton-authenticator-omarchy-helper@local`. By hand:
  `~/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator/scripts/setup-helper.sh`.
  To compile it on your own machine instead (several minutes), add
  `--from-source`.

The helper replaces Proton's own Linux app (`proton-authenticator`) on the same
machine, because the two share one data folder and cannot run together. The
installer asks before removing it; your codes and sign-in are kept.

## How it works

Proton's Linux app has no command line or API, so no other program can read
codes from it. Rather than re-implement Proton's encryption in the shell, the
**helper is Proton's own app**, built from Proton's official source for the
release (`release/proton-authenticator@1.1.6`) with
[one patch](packaging/helper/omarchy-helper.patch) that:

- adds a private local socket the panel talks to (owner-only, and the helper
  checks the connecting user);
- runs the app hidden in the background as a hardened user service, and opens
  Proton's window on request (sign-in, add, manage);
- turns off the in-app updater, since updates come from the package;
- lets Hyprland float Proton's windows without a title bar.

Sign-in, keys, encryption, and sync are Proton's code, unchanged. The patched
tree is on the
[`omarchy-authenticator-helper`](https://github.com/Zeus-Deus/WebClients/tree/omarchy-authenticator-helper)
branch of a WebClients fork.

The build recipe is [`packaging/helper/`](packaging/helper/). It pins Proton's
source by full commit and every download and file by SHA-256.
[`helper/proton-helper.lock.json`](helper/proton-helper.lock.json) pins the
recipe files and the SHA-256 of the prebuilt package.

That package is built once per helper version by
[a GitHub Actions workflow](.github/workflows/helper-release.yml) from the
recipe at a `helper-v*` tag, in a clean Arch Linux container, and published as
a [release](https://github.com/Zeus-Deus/proton-authenticator-omarchy-plugin/releases)
with a signed build-provenance attestation. Check any copy with:

```bash
gh attestation verify <file>.pkg.tar.zst --repo Zeus-Deus/proton-authenticator-omarchy-plugin
```

## Security

- Your Proton password, 2FA, keys, and TOTP secrets never reach the panel.
  The panel receives only the rows it shows (service, account, current and next
  code), only while it is open, and forgets them when it closes.
- Copying sends the helper an item ID; the helper writes the clipboard itself
  and clears it after 20 seconds.
- The plugin makes no network connections of its own: no telemetry, analytics,
  or update check. The helper talks only to Proton, like Proton's own app.
- Proton's windows are hidden from screenshots and screen sharing, because they
  can show your secrets. To capture one on purpose:
  `omarchy-toggle proton-authenticator-screen-share on && hyprctl reload`,
  reopen the window, and turn it `off` again afterwards.
- Codes shown in the panel are ordinary pixels in the shell, so screenshots of
  the panel itself can capture them.
- The helper socket trusts your Unix user, not one program: anything running as
  you could ask it for codes, just as it could read Proton's own app data. It
  is not a defence against malware already running as your user.

Details: [SECURITY.md](SECURITY.md).

### For reviewers

The plugin runs these commands, all as fixed argv arrays with no shell in
between (except the installer terminal, whose command line is built from
constants only):

- `Service.qml`: `/usr/bin/python3 scripts/helper_client.py <op>` talks to the
  helper socket. `op` is one of `status`, `snapshot`, `copy`, `lock`, `open`,
  `probe`; the only variable arguments are a code's item ID (checked against
  `[A-Za-z0-9._:-]{1,128}`) and a window name from `login`, `add`, `manage`.
- `Service.qml`: `/usr/bin/systemctl --user enable --now` or `restart`
  `proton-authenticator-omarchy-helper.service`, from the panel's **Start
  helper** and **Restart helper** buttons.
- `Service.qml`: **Install secure helper** (and **Update secure helper**) opens
  `omarchy-launch-floating-terminal-with-presentation scripts/setup-helper.sh`.
  That script runs in a terminal you can see. It downloads the helper package
  over HTTPS from this repository's `helper-v*` release (URL and SHA-256 from
  `helper/proton-helper.lock.json`), installs it with `sudo pacman -U` only if
  the SHA-256 matches, and removes Proton's own app with `omarchy-pkg-drop`
  only after a `gum confirm`. With `--from-source` it instead checks
  `packaging/helper/` against its pins and builds it with `makepkg`. Nothing
  comes from the AUR, and the package name ends in `@local`, which no AUR
  package can have, so `omarchy update` never replaces it. `sudo` is only ever
  typed by you in that terminal; the plugin itself never runs a package
  manager or `sudo`.
- `Service.qml`: **What gets installed?** opens this README's
  [How it works](#how-it-works) section with `omarchy-launch-browser`.

## Remove

```bash
systemctl --user disable --now proton-authenticator-omarchy-helper.service
omarchy pkg drop proton-authenticator-omarchy-helper@local
omarchy plugin remove io.github.zeus-deus.proton-authenticator
```

Removing the package leaves Proton's data folder
(`~/.local/share/me.proton.authenticator`) in place, so Proton's own app can
take over the same sign-in. Delete that folder to remove every local trace;
your codes stay on your Proton account. The plugin keeps no settings or data
of its own.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [SECURITY.md](SECURITY.md).

## License

The plugin is [MIT](LICENSE). The helper recipe and its patch
(`packaging/helper/`) are GPL-3.0, like Proton Authenticator. No Proton artwork or binaries are in this
repository.
