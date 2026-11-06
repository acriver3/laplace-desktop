# Laplace Runtime

The Laplace Runtime is the single local owner of connectors, credentials, browser approvals,
AI-client registrations, and the relay to hosted Laplace. Desktop, the CLI, the local MCP bridge,
and the hosted relay are clients of it. It is the only local owner since Desktop 0.1.30; the
earlier Electron-owned helper and its `LAPLACE_UNIFIED_RUNTIME_V1` switch were removed.

Source: `packages/local-runtime`. Builds: `helper/service.cjs` (background service),
`helper/launcher.cjs` (stable command entry), and `helper/bridge.cjs` (AI-client stdio bridge).

## Processes and control

- One service per OS user and profile. `hosted` is production; `local` is development and never
  starts at login. `manager.lock` keeps a single owner; concurrent starts converge on it.
- Profile state stays in Desktop's existing roots (`<userData>/profiles/<profile>`); keychain
  identities depend on these paths.
- The loopback server exposes MCP at `/mcp` (AI-client tokens) and the versioned control API at
  `/control/v1/` (management token from the 0600 `runtime.json`). Browser origins are rejected and
  AI-client tokens never authorize control requests.
- `service.json` records how to start the runtime so AI-client bridges can start it on demand.

## Lifecycle

| Action                | Behavior                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login                 | macOS LaunchAgent, Windows `HKCU\...\Run` value, or a systemd user unit runs `laplace-runtime autostart`. Clears an explicit stop. No keep-alive or respawn. |
| Close Desktop         | Desktop disconnects; the runtime keeps serving AI clients.                                                                                                   |
| Stop Laplace Runtime  | Stops connectors and relay access, writes `stopped.json`. Lasts until a manual start or the next login.                                                      |
| Terminated externally | Not respawned. Bridges report it stopped until a manual start.                                                                                               |
| Start                 | Desktop, `laplace-runtime start`, or login.                                                                                                                  |
| Start at login        | On by default for installed Desktop; the opt-out is remembered.                                                                                              |

Screen lock and sleep lock credentials and resume browser recovery inside the runtime, so they
work without Desktop. Keep-awake (off by default) holds an idle-sleep assertion only while
remote sharing is enabled and the computer is on external power.

## Installation

Desktop copies its bundled runtime tree into a versioned, stable per-user location on start:

- macOS: `~/Library/Application Support/Laplace/runtime`
- Windows: `%LOCALAPPDATA%\Laplace\runtime`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/laplace/runtime`

`versions/<version>` holds complete trees, `current`/`previous` select them, and
`bin/laplace-runtime[.cmd]` is the stable launcher used by login entries and registrations.

Headless installs use `pnpm --filter @repo/desktop package:runtime`, which produces
`laplace-runtime-<version>-<target>` archives containing the same tree. `install.sh` /
`install.cmd` installs it, enables login start (unless `--no-autostart`), and starts it:

```
laplace-runtime status | start | stop | enable | disable [--profile hosted|local]
```

Headless installations link through browser approval (`link.start` / `link.poll`). Builds are
not code-signed; macOS quarantine attributes are removed from the installed tree.

## Local and remote access

- Direct local calls follow local policy only: the registered AI client, its allowed tools, the
  connector's local tools, and provider/browser approval. They never wait on Laplace cloud, so
  they keep working during an outage or after cloud sign-out. When the runtime first runs, each
  linked connector keeps exactly the tools its last cloud permissions allowed; connectors without
  them stay disabled for local review.
- Remote use goes through the existing relay and is off by default. It requires the
  installation's remote access switch, a connection marked available remotely, an explicitly
  selected hosted AI client (its OAuth grant principal), and that client's scopes. Selection is
  made by the user in Laplace → Devices; MCP tools cannot grant it.
- The runtime announces relay protocol 2. Hosted Laplace refuses selected-client access through
  older runtimes. Every relayed call carries the selected principal, which hosted Laplace checks
  at dispatch and the runtime re-authorizes when the call leaves its queue.
- Revoking a client, deselecting it, or turning remote access off fails queued and in-flight
  remote work and cancels it where possible; dispatched provider actions cannot be rolled back.
  Offline computers fail immediately and reconnects never replay calls.

`laplace_status` and `laplace_setup` exist on both the local and the hosted MCP servers. The
standalone CLI's `laplace_local_status` and `laplace_local_setup` remain as aliases.

## Updates and background work

- Desktop installs its bundled runtime as a new version and moves a running older runtime onto it:
  local work drains under the shared maintenance lease (new calls return "not started"), the old
  process stops, the new version must report its version and status, and any failure restores
  and restarts the previous version. Busy runtimes are retried every five minutes. Headless
  `install` uses the same swap. Interrupted calls are never replayed.
- Without a connected Desktop, the runtime runs the managed-connector update schedule itself
  (opt-in preference, signed releases, 15 minutes of inactivity, deferral, and a wake delay),
  exactly as the standalone CLI's `serve` did. Desktop keeps its own schedule while connected.
- Point captures stay in the per-user Laplace data directory; the runtime enforces their
  seven-day retention even when Desktop is closed. Capture, overlay, and clipboard remain
  Desktop OS adapters.

## Rollout

The runtime became the default in Desktop 0.1.30 and the only local owner afterwards: the Electron
IPC host, `launcher.json` relaunch, and `LAPLACE_UNIFIED_RUNTIME_V1` switch are gone. To roll back,
reinstall an earlier Desktop release. Desktop still forwards its own suspend and screen-lock events
to lock credentials immediately, in addition to the runtime's monitor.
