# Security

## Development warning

The panel-native helper is implemented and has been exercised with public local
RFC fixtures and as a real AUR package build. The fixture must never be used
with real secrets. Interactive Proton login and cross-device encrypted sync
remain unverified until the user performs a real-account acceptance test.

## Process boundary

Omarchy plugins execute unsandboxed inside the long-running shell. The plugin
therefore does not implement Proton authentication, sync, decryption, storage,
TOTP generation, or clipboard writes.

The separate GPL-3 helper derived from Proton's open-source Authenticator owns:

- Proton login and session refresh;
- OS-keyring/storage-key access;
- encrypted entry synchronization and decryption;
- current/next code generation using Proton's official Rust core;
- lock/logout state;
- clipboard write and conditional expiry.

The QML process receives bounded display rows because the user explicitly
requires visible codes in the popup. Closing the panel, hiding rows, and locking
the helper must all clear those rows immediately.

## Unix-socket contract

- runtime directory mode: `0700`;
- socket mode: `0600`;
- production helper verifies peer UID with `SO_PEERCRED`;
- protocol: one bounded line-delimited JSON request and response;
- request operations: `status`, `snapshot`, `copy`, `lock`, `open`;
- copy carries only an opaque validated item ID;
- `open` carries only a view from a fixed set (`manage`, `login`, `add`) and
  shows Proton's own window from the running service. It carries no
  credentials and never touches the snapshot or the lock latch; it grants
  nothing beyond what the single-instance D-Bus name below already allows any
  same-UID process to do. It exists so the panel reaches the *sandboxed*
  service instead of executing a second, unconfined helper process;
- `copy` and `lock` are serialised: a lock either runs first (the copy sees
  the latch and refuses) or runs after (and terminates that copy's clipboard
  owner). Rows whose TOTP window has already closed are never served;
- `status` and `snapshot` also report `api` (the helper's feature level),
  `helperVersion`, `latched` (the one-way lock below), and `binaryReplaced`
  (the package manager replaced the binary; the old process still runs). The
  panel uses them to offer update and restart, never to decide what to trust;
- `status` reports state, counts, a `signedIn` boolean, the helper's per-process
  `instance`, and the `sourceCommit` the binary was built from. It does **not**
  report the account: it is the one op a client may call before deciding to
  trust the socket, so it must not disclose which Proton identity is signed in;
- every response names the helper's `instance`, a random 128-bit value chosen
  at process start. Generations restart at 1 with each helper process, and the
  panel's staleness floor is scoped to one instance: a response from a new
  instance resets the floor, a response from the same instance can never lower
  it, and a response with no instance can never reset it. Without this, the
  helper restart that is the documented way out of a lock would leave the panel
  silently rejecting every fresh snapshot for as long as the old process had
  run;
- responses are capped at 1 MiB of UTF-8 bytes and 200 rows;
- the helper stamps each publication and treats one older than 5 seconds as
  expired: a `ready` snapshot degrades to `unavailable` with no rows and
  `stale: true`, and `copy` fails with `stale` rather than handing out a code
  that has already rolled over. The panel shows this as a transient paused
  state, not as an unavailable helper;
- code, ID, type, and period validation is fail-closed; metadata text is
  sanitized for controls, bidi marks, and invisible/filler code points;
- generation IDs are a monotonic floor that survives panel close, so a replayed
  pre-lock response cannot repopulate rows, and a response carrying a
  generation outside `0..2^31-1` is rejected whole rather than clamped (a
  clamp would still raise the floor to the cap and wedge the panel).

The mode bits and `SO_PEERCRED` are **directional**: they protect the helper
from clients. They do not protect the client from a hijacked socket path, so
the client separately `lstat`s the socket and its parent before connecting and
requires a real socket, the current euid as owner, and owner-private modes.
Both sides also bound the exchange with a wall-clock deadline, because a
per-`recv` timeout alone can be reset indefinitely by a slow drip.

The client's `PROTON_AUTH_HELPER_SOCKET` override is honoured only together with
an explicit `--allow-socket-override` flag that the plugin never passes, so the
shell's environment cannot redirect production requests. Every error the client
emits is one of a fixed set of identifiers, and the panel maps those to a fixed
set of messages; raw Python exception text, paths, and server payloads never
reach the hero or the `status` IPC verb.

## Explicit prohibitions

- no password, 2FA login code, token, TOTP seed, generated code, or key in argv;
- no credentials or vault material in `shell.json`, logs, notifications, IPC
  status, or environment variables;
- the helper unit sets `LimitCORE=0` so a helper crash does not write vault
  material to coredump storage. This does **not** extend to `omarchy-shell`:
  that process renders codes while the panel is open, it is not covered by this
  unit, and quickshell core dumps do occur in practice. Visible codes remain
  exposed to screenshots, screen sharing, and shell crash dumps;
- no direct reads of Proton IndexedDB/keyring from QML;
- no private Proton API implementation in QML;
- no background runtime downloads or unpinned helper updates: Proton's in-app
  updater is disabled on Linux, and the helper changes only when the package
  manager installs a new version of the AUR package;
- the panel never runs a package manager or sudo itself. **Install secure
  helper** opens Omarchy's floating terminal on `scripts/setup-helper.sh`, where
  the user sees each step and types sudo; the only argument is a fixed mode
  (`install` or `update`);
- no title-only window or helper identity matching.

## Shell IPC surface

The plugin publishes IPC verbs on the Quickshell socket, which any process
running as the same user can call with no authentication; `manageIpc: false`
adds none. Only fail-safe verbs are published:

- `open`, `close`, `show`, `hide`, `toggle` — visibility only;
- `refresh` — re-reads the snapshot the panel would read anyway;
- `lock` — moves toward the safe state;
- `status` — booleans, state name, entry count, and error text; no codes.

`unlock`, `copy`, `login`, and install/start/restart are deliberately **not**
exposed. Copying a code, opening Proton's window, and running the installer
require focused input in the panel. There is no `unlock` verb to expose: the
helper removed that socket operation entirely.

## Hiding codes

There are two distinct controls, and they are not the same strength:

- **Panel-local hide (`L`).** The panel stops rendering rows and stops polling
  the helper. Nothing is sent over the socket, and **the helper still holds the
  codes** — this hides them from the screen, not from the machine. It is
  reversible from the panel because it never left the panel.
- **Helper lock (`x`, and the `lock` IPC verb).** The helper clears its
  published snapshot, drops the clipboard owner, and latches itself locked.
  This is one-way: the socket exposes no release operation, so the helper stays
  locked until the helper service restarts. The locked panel offers **Restart
  helper**, which runs `systemctl --user restart` on the unit — a same-UID
  action any process could already take, not a socket release path. In the
  panel `x` opens a confirmation that defaults to Cancel, so `x` followed by
  Enter cannot clear the helper. The watchdog never restarts a latched helper
  for an upgrade, because that restart would release the latch.

The asymmetry is deliberate. A socket "resume" operation would be callable by
any same-UID process, so it would be a release path for every process on the
session rather than for the panel specifically, and the mode bits and
`SO_PEERCRED` cannot tell those apart. Keeping the resume purely panel-local is
honest: the panel controls only its own rendering, and the one control that
really removes code material from the helper is fail-safe in one direction.

## Residual risk

- `SO_PEERCRED` authenticates a Unix UID, not one trusted application. Any
  same-UID process — including another unsandboxed shell plugin — can talk to
  the helper socket. Neither hiding control is authentication against same-UID
  malware: panel-local hiding leaves the helper holding the codes, and the
  helper lock only stops the helper serving them to anyone until it restarts.
- Omarchy plugins run unsandboxed inside `omarchy-shell`, so another plugin
  shares that process with rendered codes.
- Visible codes lose the vendor client's window protections: screenshots,
  screen sharing, and shell crash dumps are residual exposure.
- Clipboard-manager history is outside the helper's control.

## Single-instance D-Bus name

The helper keeps Proton's `me.proton.authenticator` identifier, so it owns the
`me.proton.authenticator.SingleInstance` session-bus name. Any same-UID client
can call that name's `ExecuteCallback` with arbitrary argv; the helper treats
the forwarded argv as a request, not a command line. Exactly two shapes are
honoured — no flags (surface the window, as a desktop-entry relaunch would) and
exactly `--login` (surface Proton's own sign-in modal). Anything else is
ignored. Neither shape clears the lock latch or touches the snapshot. Both run
the same code as the socket's `open` op. The panel itself uses only the
socket.

Because the identifier, data directory (`~/.local/share/me.proton.authenticator`),
config, cookie jar, and keyring service name (`com.proton.authenticator`) are
all shared with Proton's official Linux app, **the official AppImage and the
helper must not be installed together**: launching the official app while the
helper runs forwards to the helper and exits, an official app that is already
running makes the helper exit 0 (which `Restart=on-failure` does not restart),
and a version drift between the two would run the newer one's database
migration against the other's data. The helper *is* the pinned official 1.1.6
source plus the socket; this host runs only the helper. The AUR package
declares `conflicts=` on Proton's packages, and the installer offers to remove
them.

## Clipboard

Production copy happens in the helper, not QML. The helper owns one
`wl-copy --foreground --sensitive` process and terminates that exact process
after 20 seconds, on replacement, or on privacy lock. External clipboard owners
are never cleared. Copying the same current code again replaces the owner and
renews the 20-second window. The helper reports `copied: true` only after the
child has stayed alive through a short grace period, since a foreground
`wl-copy` that fails to bind the selection exits immediately. Clipboard-manager
history may retain copied values and must be treated as outside the helper's
control.

The background helper logs at Warn and above only, to the journal and Proton's
log file. Upstream's Debug level records entry IDs and keyring lookups and is
used only by ordinary foreground launches.

## Service hardening

The helper runs as a user systemd unit shipped by the package at
`/usr/lib/systemd/user/proton-authenticator-omarchy-helper.service`, hardened
with `LimitCORE=0`, `UMask=0077`, `NoNewPrivileges`, `ProtectSystem=strict`,
`ProtectHome=read-only` plus explicit `ReadWritePaths`, `PrivateTmp`, the
kernel/cgroup/clock protections, an empty capability bounding set, and a
syscall filter.

The syscall filter adds `mincore` explicitly. JavaScriptCore's garbage
collector calls it and current systemd leaves it out of `@system-service`, so
without it the kernel killed `WebKitWebProcess` with SIGSYS while the service
kept reporting active and silently stopped publishing codes. The helper's
watchdog now also reloads a web view that has not published for 45 seconds.

`ReadWritePaths` includes `~/Downloads` (if it exists) because that is where
Proton's own Export and encrypted automatic backups write from the Manage
window; the rest of the home directory stays read-only.

`RestrictSUIDSGID`, `RestrictNamespaces`, `MemoryDenyWriteExecute`, and
`PrivateUsers` are deliberately **omitted**, not overlooked: each breaks either
WebKitGTK's own bubblewrap sandbox or its JIT, which would be a net security
loss. The reasoning and the reproduction command for each are recorded in the
unit file itself.

## Source pinning and artifact provenance

`helper/proton-helper.lock.json` pins Proton's release (`1.1.6`, release-branch
commit `0deabe38…`), the SHA-256 of Proton's source tarball for that commit,
the patch file and its SHA-256, the patched-tree commit, and the official core
npm package integrity. The AUR `PKGBUILD` (a copy is in `packaging/aur/`)
verifies the tarball, the Node toolchain, the patch, and the unit by SHA-256
before building; `cargo fetch --locked` and Proton's own `yarn.lock` pin every
dependency. A contract test fails if the panel, the lock file, and the
`PKGBUILD` disagree on any of these.

Open source enables review; it is not by itself proof of safety, and a build
from source cannot carry Proton's signature. Updates require a diff review of
Proton's changes, re-applying the patch, the full test suite, and a live check.

The pin alone does not say what is *running*. The helper's `build.rs` embeds the
patched-tree commit (the `PKGBUILD` passes it in, since a release tarball has
no git metadata); the build verifier refuses an artifact that ships Proton's QA
hooks, devtools, or source maps; and the `status` socket op reports
`sourceCommit` and `helperVersion`. A review of the helper therefore starts with
`omarchy-shell proton-authenticator status` and those values, not with the
source tree.
