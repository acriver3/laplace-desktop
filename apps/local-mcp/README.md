# Laplace CLI

Manage the same connectors, approvals, credentials, and AI-client registrations as
Laplace Desktop from your terminal. The CLI uses the shared Laplace Runtime.

## Install

Requires Node.js 24 or newer.

```sh
npm install --global @withlaplace/cli
laplace --version
laplace setup
laplace start
laplace connectors catalog
```

Or use `npx @withlaplace/cli --help`. Compatibility commands `laplace-local`
and `laplace-runtime` are included.

The matching optional `@withlaplace/runtime-<platform>-<architecture>` package
contains Node/npm, uv, browser assets, and the keychain binding. Keep optional
dependencies enabled for standalone use. Installation has no postinstall script.
`setup` installs the runtime into the stable per-user location without enabling
startup or starting a stopped service. Use `enable` / `disable` for login startup.

Targets: Windows x64, Linux x64/glibc, macOS Apple Silicon and Intel.
Linux requires an unlocked Secret Service keychain and session bus.
Individual connectors may require an installed browser and provider sign-in.

Already using Desktop? The CLI reuses its profile and selected runtime. Setup
does not downgrade a newer runtime. After `npm update -g @withlaplace/cli`, run
`laplace setup` to update the runtime. Busy/failed swaps report failure.
Desktop before 0.1.49 can select its own bundled runtime on launch; the npm CLI
can still manage its compatible control API. This package does not update Electron
or advertise a Desktop update.

## Management

Run `laplace --help` for the complete command list.

```sh
laplace connectors list
laplace connectors show <id>
laplace connectors fields <id>
laplace connectors install <catalog-id> --config ./settings.json --confirm --wait
laplace connectors install-bundle ./connector.mcpb --confirm --wait
laplace connectors configure <id> --config ./settings.json --confirm
laplace connectors authenticate|verify|repair|start|stop|restart|remove <id> --confirm
laplace connectors versions <id>
laplace connectors set-version <id> <version-or-tag> --confirm
laplace connectors add-npm <id> <package> [version] --confirm
laplace connectors preview --config ./server.json
laplace connectors add --config ./server.json --confirm
laplace connectors edit <id> --config ./server.json --confirm
laplace connectors permissions <id> --tools tool_a,tool_b --confirm
laplace connectors access <id> --visible true --remote false --confirm
laplace connectors devices
laplace connectors copy <source-id> --confirm
laplace jobs list
laplace jobs show|wait|retry|cancel <operation-id>
laplace clients list
laplace clients register <name> --confirm
laplace clients revoke <id> --confirm
laplace clients permissions <id> --tools none --confirm
laplace clients connect <id> [--desktop-management] --confirm
laplace clients disconnect <id> --confirm
laplace runtime info
laplace runtime settings
laplace runtime keep-awake on|off --confirm
laplace credentials status
```

Connector/client mutations prompt in a terminal; scripts must pass `--confirm`
after review. Use `--tools none` for an empty allowlist, or `--tools all` for an
unrestricted registered client. Remote connector access does not grant hosted AI
clients access: selected-client authorization still applies.

Configuration files are JSON objects containing string values for catalog settings,
for example `{"canvas_url":"https://school.instructure.com"}`. Put credentials in
protected configuration files instead of command-line arguments.

Install/copy return durable operation IDs. `--wait` polls until ready or until user
action is needed; it never approves browser access. Use `approvals list` and
`approvals open <request-id>` for browser approval. Failed, cancelled, interrupted,
or timed-out waits exit nonzero without replaying an install.
`--timeout <seconds>` defaults to 600. Use `--idempotency-key <key>` to retry
the same install/copy/manage request durably.

Results are JSON objects; help/version are text. Preview/progress commands can
print multiple objects. Errors/prompts go to stderr; `serve` reserves stdout for
MCP frames. Credential approvals and capture/clipboard stay in Desktop/browser
surfaces. Local connectors work without signing into Laplace.

## Compatibility

Lifecycle, login/logout, `install-client`, `serve`, `import`, `import-legacy`,
`browser`, `approvals`, and `updates` remain supported. Browser setup accepts
both `--workspace` and `--config`. Repair performs connector repair; use
`connectors restart` for a simple restart.

Append `--profile hosted|local` (default hosted). Development never autostarts.
`--root <path>` selects a profile directory for management/lifecycle commands.
`start --no-native-host` skips browser native-messaging registration.

## Build and release

Run `pnpm --filter @repo/local-mcp package:npm <target>`. Publishable packages
are generated in `apps/local-mcp/dist/npm/cli` and `dist/npm/<target>`.
Workspace dependencies are bundled, and public manifests contain no workspace
or catalog dependency protocols. Runtime downloads and browser assets are pinned
and integrity-checked.

Build Windows native helpers on Windows. Cross-packaging requires
`LAPLACE_WINDOWS_NATIVE_DIR` with freshly compiled process-host.exe,
browser-native-host.exe, and laplace-runtime-hidden.exe. Cross-build results
are not native execution evidence.

Pack the generated directories with `npm pack`, then test the tarballs:

```sh
node apps/local-mcp/scripts/smoke-npm.mjs <cli.tgz> <native-runtime.tgz>
```

Linux needs an unlocked test Secret Service session. Windows needs
`LAPLACE_SMOKE_NPM_CLI` pointing to npm-cli.js. Tests isolate profiles and avoid
login startup and browser native-host registration.

Publish immutable platform versions before the CLI. Verify fresh registry install,
version, setup, and runtime health. Record source commit, tarball integrity, and
actual native/cross-build validation. Use `cli-v<version>` release tags without
changing Desktop's signed update index; Desktop installers retain their separate
native acceptance requirements.
