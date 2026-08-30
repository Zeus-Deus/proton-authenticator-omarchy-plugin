# Proton Authenticator Companion for Omarchy Quattro

A native Omarchy bar widget that opens and focuses **Proton's official Linux
Authenticator app** while keeping your 2FA vault out of the unsandboxed
`omarchy-shell` process.

> Independent companion project. Not affiliated with or endorsed by Proton AG
> or Omarchy. “Proton” and “Proton Authenticator” are used nominatively to
> identify the app this plugin launches.

## Why it is a companion, not a second authenticator

Proton already ships a Linux Authenticator with Proton-account sync,
end-to-end encryption, offline code generation, import/export, and app lock.[1][3][16]
Its production desktop window is content-protected.[9]

The desktop source exposes no supported CLI, deep link, or IPC command for
listing/copying codes.[9] Its item database is encrypted and the storage key
lives in the OS keyring.[11][12] Proton user keys only live in app memory.[13]
Reading those private files or reimplementing Proton login would weaken the
security boundary the official app deliberately provides.

Therefore this plugin only:

- detects the official executable;
- shows whether its protected window is open;
- opens or focuses it using safe argv arrays;
- offers Proton's official download/help pages;
- optionally launches a **prompting**, user-local installer for Proton's signed
  AppImage from Proton's signed updater metadata;[7][8]
- supports Proton's documented DMA-BUF workaround for Linux white screens.[15]

It never reads Proton session data, IndexedDB, keyring entries, TOTP seeds,
generated codes, logs, or clipboard contents.

## Install the plugin

```bash
omarchy plugin add https://github.com/Zeus-Deus/proton-authenticator-omarchy-plugin --enable --yes
```

For local development:

```bash
omarchy plugin add "$PWD" --enable --yes
```

The panel's **Install official AppImage** action opens a terminal. The installer:

1. fetches Proton's official `latest.json`;
2. allows only `https://proton.me/download/authenticator/linux/*.AppImage`;
3. verifies the `ED` minisign/Tauri signature with Proton's pinned updater key
   (Ed25519 over BLAKE2b-512, including the trusted-comment signature);
4. installs atomically to
   `~/.local/opt/proton-authenticator/ProtonAuthenticator.AppImage`;
5. creates `~/.local/bin/proton-authenticator`.

It is **not** an auto-updater, never uses `sudo`, shows the version/source/target,
and defaults to **No**.

## Use

- Left-click bar icon: panel
- Right-click bar icon: open/focus Proton Authenticator
- Middle-click: refresh status
- Panel keys: `j/k`, Enter, `o` open, `r` refresh, `d` download, `s` support

Sign in to your Proton account **inside the official app** to sync codes from
iPhone to Linux. Proton says Linux/Windows/Android sync requires a Proton
account; account-less local TOTP use is also supported.[1][3][4]

## Settings

- **Status refresh interval** — active only while the panel is open.
- **Disable DMA-BUF rendering** — launches with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`, Proton's documented workaround for a
  white window on some Linux/NVIDIA setups.[15]

## Development and verification

```bash
node --test tests/model.test.js
python3 -m unittest tests/test_installer.py -v
omarchy plugin validate .
omarchy-restart-shell
qs log -p /usr/share/omarchy/shell --tail 60
omarchy-shell proton-authenticator-companion status
```

`qmllint` is not authoritative for Omarchy plugins because it cannot resolve
`qs.Ui` / `qs.Commons`.

## Security properties

See [SECURITY.md](SECURITY.md). The short version:

- plugin code is unsandboxed, so no vault material enters it;
- every child command is an argv array except a fixed literal used only to
  resolve the executable from PATH;
- window addresses are accepted only as `0x[0-9A-Fa-f]+`;
- external JSON is size-capped and parsed fail-closed;
- no secrets in argv/environment/logs;
- no background download or update.

## Sources

[1] https://proton.me/authenticator
[3] https://proton.me/support/get-started-proton-authenticator
[4] https://proton.me/support/proton-authenticator-faqs
[7] https://raw.githubusercontent.com/ProtonMail/WebClients/main/applications/authenticator/src-tauri/tauri.conf.json
[8] https://proton.me/download/authenticator/linux/latest.json
[9] https://raw.githubusercontent.com/ProtonMail/WebClients/main/applications/authenticator/src-tauri/src/lib.rs
[11] https://raw.githubusercontent.com/ProtonMail/WebClients/main/applications/authenticator/src-tauri/src/storage_key.rs
[12] https://raw.githubusercontent.com/ProtonMail/WebClients/main/applications/authenticator/src/lib/db/db.ts
[13] https://raw.githubusercontent.com/ProtonMail/WebClients/main/applications/authenticator/src/lib/auth/service.ts
[15] https://proton.me/support/authenticator-linux-issue
[16] https://raw.githubusercontent.com/ProtonMail/WebClients/main/applications/authenticator/me.proton.Authenticator.metainfo.xml

## License

Plugin code: MIT. Proton Authenticator is a separate GPL-3.0 application from
Proton AG and is not bundled in this repository.
