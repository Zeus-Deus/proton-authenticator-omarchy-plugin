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
requires visible codes in the popup. Closing or locking must clear those rows.

## Unix-socket contract

- runtime directory mode: `0700`;
- socket mode: `0600`;
- production helper verifies peer UID with `SO_PEERCRED`;
- protocol: one bounded line-delimited JSON request and response;
- request operations: `status`, `snapshot`, `copy`, `lock`, `unlock`;
- copy carries only an opaque validated item ID;
- responses are capped at 1 MiB and 200 rows;
- metadata and codes are sanitized and validated fail-closed;
- generation IDs prevent stale post-lock responses from repopulating rows.

## Explicit prohibitions

- no password, 2FA login code, token, TOTP seed, generated code, or key in argv;
- no credentials or vault material in `shell.json`, logs, notifications, IPC
  status, environment variables, or crash messages;
- no direct reads of Proton IndexedDB/keyring from QML;
- no private Proton API implementation in QML;
- no background runtime downloads or unpinned helper updates;
- no title-only window or helper identity matching.

## Clipboard

Production copy happens in the helper, not QML. The helper writes through stdin
and clears after 20 seconds only if the clipboard still contains the code it
wrote; copying the same current code again renews the 20-second window. It never
deletes newer user data. That copy/expiry path was live-tested with the public
RFC entry. Clipboard-manager history may retain copied values and must be treated
as outside the helper's control.

The background helper disables Proton application logging entirely. Normal
foreground Proton launches retain upstream logging behavior.

## Source pinning

`helper/proton-helper.lock.json` pins the exact Proton WebClients commit and the
official core npm package integrity. Open source enables review; it is not by
itself proof of safety. Updates require a diff review, cryptographic integrity
update, and the full test/live-acceptance suite.
