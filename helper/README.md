# Pinned helper boundary

The production helper is developed in the pinned fork:

- upstream: `ProtonMail/WebClients`
- fork: `Zeus-Deus/WebClients`
- exact commit and official core package integrity: `proton-helper.lock.json`

It remains GPL-3 and owns Proton login, encrypted sync, entry decryption, code
generation, locking, and clipboard writes. The MIT QML plugin is only a bounded
client of its user-owned Unix socket.

`fixture-server.mjs` is test-only. It uses Proton's official published
`@protontech/authenticator-rust-core` package and the public RFC 6238 test secret
to prove current/next code rendering without a Proton account. It refuses to
start without `--fixture` and must never be installed or launched by the plugin.

Install the pinned test dependency and run the integration test:

```bash
npm ci --prefix helper --ignore-scripts --no-audit --no-fund
node --test tests/helper.integration.test.js
```

The fixture runtime directory is mode `0700`; its Unix socket is `0600`.
