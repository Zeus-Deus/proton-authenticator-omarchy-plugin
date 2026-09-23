# Helper pin

The panel's codes come from the helper: Proton's official Authenticator source
for one release, with one patch that adds a private local socket. It is
built on the user's machine from the recipe in
[`../packaging/helper/`](../packaging/helper/) as the local package
`proton-authenticator-omarchy-helper@local`. It is not an AUR package.

[`proton-helper.lock.json`](proton-helper.lock.json) pins:

- `protonVersion` / `releaseBranch` / `baseCommit`: the Proton release the
  helper is built from, and `baseTarballSha256` for Proton's source tarball of
  that commit;
- `helperCommit`: the patched tree in `Zeus-Deus/WebClients` (branch
  `omarchy-authenticator-helper`), embedded in the binary and reported as
  `sourceCommit` over the socket;
- `patch` / `patchSha256`: the patch the package applies;
- `recipe`: the SHA-256 of every file in `packaging/helper/`, checked by
  `scripts/setup-helper.sh` before it builds anything;
- `helperApi`: the socket feature level this panel expects;
- `authenticatorRustCore`: the official core package the **test fixture** uses.

The panel installs, starts, and restarts the helper itself (see the README). By
hand:

```bash
~/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator/scripts/setup-helper.sh
```

## Test fixture

`tests/fixtures/fixture-server.mjs` is test-only and lives under `tests/`. It
uses Proton's official published `@protontech/authenticator-rust-core` package
and the public RFC 6238 test secret to prove current/next code rendering without
a Proton account. It refuses to start without `--fixture`, without
`PROTON_AUTH_FIXTURE=1`, under `NODE_ENV=production`, or from a path inside
`~/.config/omarchy/plugins/`. It must never be installed or launched by the
plugin.

`omarchy plugin add` clones the whole repository, so an installed checkout must
exclude the development tree explicitly. `.gitattributes` marks `/tests` as
`export-ignore` for archive-based distribution, and a git checkout is narrowed
with sparse-checkout:

```bash
plugin_dir=~/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator
git -C "$plugin_dir" sparse-checkout set --no-cone '/*' '!/tests'
test ! -e "$plugin_dir/tests"
```
