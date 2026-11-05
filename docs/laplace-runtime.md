# Laplace Runtime

The Laplace Runtime is the single local owner of connectors, credentials, browser approvals,
AI-client registrations, and the relay to hosted Laplace. Desktop, the CLI, the local MCP bridge,
and the hosted relay are clients of it. It is selected with `LAPLACE_UNIFIED_RUNTIME_V1=true`
(disabled by default); without the flag Desktop keeps its Electron-owned helper.

Source: `packages/local-runtime`. Builds: `helper/service.cjs` (background service),
`helper/launcher.cjs` (stable command entry), `helper/bridge.cjs` (AI-client stdio bridge), and
`helper/main.cjs` (legacy Electron IPC host).

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

| Action | Behavior |
| --- | --- |
| Login | macOS LaunchAgent, Windows `HKCU\...\Run` value, or a systemd user unit runs `laplace-runtime login`. Clears an explicit stop. No keep-alive or respawn. |
| Close Desktop | Desktop disconnects; the runtime keeps serving AI clients. |
| Stop Laplace Runtime | Stops connectors and relay access, writes `stopped.json`. Lasts until a manual start or the next login. |
| Terminated externally | Not respawned. Bridges report it stopped until a manual start. |
| Start | Desktop, `laplace-runtime start`, or login. |
| Start at login | On by default for installed Desktop; the opt-out is remembered. |

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
