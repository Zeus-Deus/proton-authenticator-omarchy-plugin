# Security

## Development warning

The panel-native helper is implemented and has been exercised with public local
RFC fixtures. The fixture must never be used with real secrets. Interactive
Proton login and cross-device encrypted sync remain unverified until the user
performs a real-account acceptance test.

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
- request operations: `status`, `snapshot`, `copy`, `lock`;
- copy carries only an opaque validated item ID;
- responses are capped at 1 MiB of UTF-8 bytes and 200 rows;
- the helper stamps each publication and treats one older than 5 seconds as
  expired: a `ready` snapshot degrades to `unavailable` with no rows and
  `stale: true`, and `copy` fails with `stale` rather than handing out a code
  that has already rolled over. The panel shows this as a transient paused
  state, not as an unavailable helper;
- code, ID, type, and period validation is fail-closed; metadata text is
  sanitized for controls, bidi marks, and invisible/filler code points;
- generation IDs are a monotonic floor that survives panel close, so a replayed
  pre-lock response cannot repopulate rows, and a forged counter above 2^31-1
  is rejected rather than wedging the comparison.

The mode bits and `SO_PEERCRED` are **directional**: they protect the helper
from clients. They do not protect the client from a hijacked socket path, so
the client separately `lstat`s the socket and its parent before connecting and
requires a real socket, the current euid as owner, and owner-private modes.
Both sides also bound the exchange with a wall-clock deadline, because a
per-`recv` timeout alone can be reset indefinitely by a slow drip.

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
- no background runtime downloads or unpinned helper updates;
- no title-only window or helper identity matching.

## Shell IPC surface

The plugin publishes IPC verbs on the Quickshell socket, which any process
running as the same user can call with no authentication; `manageIpc: false`
adds none. Only fail-safe verbs are published:

- `open`, `close`, `show`, `hide`, `toggle` — visibility only;
- `refresh` — re-reads the snapshot the panel would read anyway;
- `lock` — moves toward the safe state;
- `status` — booleans, state name, entry count, and error text; no codes.

`unlock`, `copy`, and `login` are deliberately **not** exposed. Copying a code
and summoning Proton's login window require focused input in the panel. There is
no `unlock` verb to expose: the helper removed that socket operation entirely.

## Hiding codes

There are two distinct controls, and they are not the same strength:

- **Panel-local hide (`L`).** The panel stops rendering rows and stops polling
  the helper. Nothing is sent over the socket, and **the helper still holds the
  codes** — this hides them from the screen, not from the machine. It is
  reversible from the panel because it never left the panel.
- **Helper lock (`x`, and the `lock` IPC verb).** The helper clears its
  published snapshot, drops the clipboard owner, and latches itself locked.
  This is one-way: the socket exposes no release operation, so the helper stays
  locked until the helper service restarts.

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

## Clipboard

Production copy happens in the helper, not QML. The helper owns one
`wl-copy --foreground --sensitive` process and terminates that exact process
after 20 seconds, on replacement, or on privacy lock. External clipboard owners
are never cleared. Copying the same current code again replaces the owner and
renews the 20-second window. Clipboard-manager history may retain copied values
and must be treated as outside the helper's control.

The background helper disables Proton application logging entirely. Normal
foreground Proton launches retain upstream logging behavior.

## Service hardening

The helper runs as a user systemd unit hardened to
`systemd-analyze security --user` ≈ **3.1 OK** (it was 9.4 UNSAFE unhardened),
with `LimitCORE=0`, `UMask=0077`, `NoNewPrivileges`, `ProtectSystem=strict`,
`ProtectHome=read-only` plus explicit `ReadWritePaths`, `PrivateTmp`, the
kernel/cgroup/clock protections, an empty capability bounding set, and a
syscall filter.

`RestrictSUIDSGID`, `RestrictNamespaces`, `MemoryDenyWriteExecute`, and
`PrivateUsers` are deliberately **omitted**, not overlooked: each breaks either
WebKitGTK's own bubblewrap sandbox or its JIT, which would be a net security
loss. The reasoning and the reproduction command for each are recorded in the
unit file itself.

## Source pinning

`helper/proton-helper.lock.json` pins the exact Proton WebClients commit and the
official core npm package integrity. Open source enables review; it is not by
itself proof of safety. Updates require a diff review, cryptographic integrity
update, and the full test/live-acceptance suite.
