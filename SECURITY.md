# Security

## Trust boundary

Omarchy Quattro plugins execute unsandboxed inside the long-running shell.
Proton Authenticator, by contrast, encrypts item records, puts the local storage
key in Secret Service/keyring, retains Proton user keys only in its own memory,
and marks its production window as content-protected.

This plugin treats the official app as the security boundary and does not cross
it.

## Explicit non-goals

The plugin does **not**:

- authenticate to Proton or implement Proton's private sync API;
- read Authenticator IndexedDB, preferences, sessions, logs, or keyring entries;
- decrypt, generate, display, search, or copy TOTP/Steam codes;
- import/export authenticator vaults;
- inspect screenshots or scrape the protected application window;
- pass passwords, tokens, seeds, or codes in argv or environment variables;
- auto-install or auto-update software in the background.

## External processes

Complete execution inventory:

| Command | Purpose | Inputs |
|---|---|---|
| `bash -lc <fixed literal>` | Resolve `proton-authenticator` from PATH or the fixed user-local install path | No untrusted input |
| `hyprctl -j clients` | Observe whether the protected app window exists | Parsed as bounded, attacker-controlled JSON |
| `hyprctl dispatch focuswindow address:<hex>` | Focus a validated window address | `0x[0-9A-Fa-f]+` only |
| `[binary]` | Launch the discovered official app | Absolute, control-free path only |
| `env WEBKIT_DISABLE_DMABUF_RENDERER=1 [binary]` | Optional Proton-documented Linux workaround | Same validated path |
| `omarchy-launch-browser <fixed HTTPS URL>` | Open official Proton pages | Fixed literals only |
| `omarchy-launch-terminal -- python3 <fixed installer path>` | Let the user explicitly run the prompting installer | Fixed path only |

No command contains vault material.

## Signed AppImage installer

`scripts/install_official_appimage.py`:

- accepts only the official Proton updater endpoint and download path;
- caps metadata at 1 MiB and the artifact at 300 MiB;
- supports only x86_64, the platform currently published in Proton's metadata;
- verifies the minisign `ED` artifact signature using Ed25519 over a streaming
  BLAKE2b-512 digest;
- verifies the global signature over the trusted comment;
- pins Proton's public updater key from the official Tauri configuration;
- uses atomic replacement and installs without root;
- is invoked only in a visible terminal and defaults to cancellation.

Running it again is a deliberate manual update, never an opening-panel side
effect.

## Reporting

Report vulnerabilities privately to the repository owner before public
publication. Proton Authenticator vulnerabilities belong in Proton's security
program, not this companion repository.
