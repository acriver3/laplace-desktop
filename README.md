# Laplace Desktop

Laplace Desktop is the local MCP manager and browser connector host for Laplace.
The app lives in [apps/desktop](apps/desktop). The workspace includes the shared
packages and assets it needs to build independently of the hosted Laplace app.

Install Node 24 and pnpm 10.28.2, then run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @repo/desktop check:source
pnpm --filter @repo/desktop dev
```

See the [Desktop guide](apps/desktop/README.md) for native packaging and the
[source updater guide](apps/desktop/SOURCE-UPDATES.md) for installation and releases.
The existing update channel remains in service while the public release and bridge are being prepared.

Connector bundles are distributed through the
[Laplace MCP Library](https://github.com/acriver3/laplace-mcp-library).

Laplace Desktop is licensed under [Apache 2.0](LICENSE). Bundled third-party
materials retain their existing license terms and notices.
