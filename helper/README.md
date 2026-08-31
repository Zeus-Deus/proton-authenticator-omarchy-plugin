# Pinned helper boundary

The production helper is developed in the pinned fork:

- upstream: `ProtonMail/WebClients`
- fork: `Zeus-Deus/WebClients`
- exact commit and official core package integrity: `proton-helper.lock.json`

It remains GPL-3 and owns Proton login, encrypted sync, entry decryption, code
generation, locking, and clipboard writes. The MIT QML plugin is only a bounded
client of its user-owned Unix socket.

The production helper runs as a hidden user service using
`proton-authenticator-omarchy-helper.service`; `--background --login` temporarily
shows Proton's own Device sync UI for sign-in. Panel hide/show uses only the
private socket and never opens Proton's window.

## Development provisioning

Until a reviewed helper release artifact is published, install a locally built
binary explicitly:

```bash
mise exec node@24.18.0 -- corepack yarn workspace proton-authenticator build:omarchy-helper
install -Dm755 /path/to/WebClients/applications/authenticator/src-tauri/target/release/proton-authenticator \
  ~/.local/opt/proton-authenticator-omarchy-helper/proton-authenticator
ln -sfn ~/.local/opt/proton-authenticator-omarchy-helper/proton-authenticator \
  ~/.local/bin/proton-authenticator-omarchy-helper
install -Dm644 helper/proton-authenticator-omarchy-helper.service \
  ~/.config/systemd/user/proton-authenticator-omarchy-helper.service
systemctl --user daemon-reload
systemctl --user enable --now proton-authenticator-omarchy-helper.service
```

The launcher and unit intentionally resolve to the same installed binary.

`tests/fixtures/fixture-server.mjs` is test-only and lives under `tests/`, never
under `helper/`. It uses Proton's official published
`@protontech/authenticator-rust-core` package and the public RFC 6238 test secret
to prove current/next code rendering without a Proton account. It refuses to
start without `--fixture`, without `PROTON_AUTH_FIXTURE=1`, under
`NODE_ENV=production`, or from a path inside `~/.config/omarchy/plugins/`. It
must never be installed or launched by the plugin.

`omarchy plugin add` clones the whole repository, so an installed checkout must
exclude the development tree explicitly. `.gitattributes` marks `/tests` as
`export-ignore` for archive-based distribution, and a git checkout is narrowed
with sparse-checkout:

```bash
plugin_dir=~/.config/omarchy/plugins/io.github.zeus-deus.proton-authenticator
git -C "$plugin_dir" sparse-checkout set --no-cone '/*' '!/tests'
```

Verify no fixture reached production:

```bash
test ! -e "$plugin_dir/tests" && test ! -e "$plugin_dir/helper/fixture-server.mjs"
```

Install the pinned test dependency and run the integration test:

```bash
npm ci --prefix tests/fixtures --ignore-scripts --no-audit --no-fund
node --test tests/helper.integration.test.js
```

The fixture runtime directory is mode `0700`; its Unix socket is `0600`.
