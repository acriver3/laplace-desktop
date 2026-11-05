# Automatic updates (disabled production candidate)

The actual automatic execution gate is `LAPLACE_AUTOMATIC_UPDATES_V1=true`; it is absent/off by default. User preferences are separate and both default off. Do not activate production until the native acceptance matrix is complete. Existing manual source updates remain available.

## Device controls

On this device → Updates has independent Desktop and managed-connector switches. Settings are shared per OS user in `~/.laplace/updates/preferences.json`. Connector pins use the installation root and connection ID, so similarly named connections remain independent. Connection cards show installed/available versions, Keep this version, update status, manual update/retry, and cancellation during downloads. No connector is managed solely because its name contains a bracketed suffix.

Automatic checks begin after 15 seconds and repeat every six hours while the host is running. Eligible artifacts are verified before staging. Application requires at least 15 minutes of computer inactivity, an exclusive maintenance lease, and no active/queued calls, setup work, credentials or browser approvals, or Point capture. Desktop gives a 60-second restart countdown with Postpone 24 hours; activity cancels the countdown. Disabling automation aborts pending automatic transfers and cancels the countdown before installation begins. A transition already journaled for installation is completed or rolled back atomically. Previous window/tray visibility is restored.

CLI scheduling runs only inside `serve`; no service is installed. macOS HID and Windows last-input adapters determine computer inactivity. Unknown/headless/unsupported idle sources defer automatic installation; `updates status` explains that state. MCP stdout remains protocol-only.

## Local CLI

```
laplace-local updates status
laplace-local updates check
laplace-local updates enable
laplace-local updates disable
laplace-local updates pin <connection-id>
laplace-local updates unpin <connection-id>
laplace-local updates apply [connection-id]
laplace-local updates defer
laplace-local updates enroll <connection-id> --directory <installed-bundle>
```

For a historical attachment without an ownership identity, enrollment also takes `--catalog <catalog-id> --version <version> --mode tethered|background-browser`. Check the signed catalog first. Enrollment requires an exact published file inventory and the existing trusted Node or LinkedIn uv launch recipe; it does not accept a shell wrapper, arbitrary custom executable, or HTTP server. Credentials/profiles stay in their existing locations. CLI self-updates and extension installation are excluded.

## Installers and recovery

Source installs retain source builds and their build tools. Downloaded apps adopt a writable stable path and use signed ZIP/Squirrel assets without Git, Node, or pnpm installations. Translocated, temporary, read-only, symlinked, and unsupported locations remain unmanaged with actionable errors. ZIP replacement uses the detached updater and its existing journal/health acknowledgment. Windows Squirrel receives a local RELEASES feed containing only signed-hash-verified full packages. The entire prior Squirrel installation is snapshotted for recovery because Squirrel has no native rollback. Stable assistant launchers and historical version-directory forwarding preserve existing registrations.

Managed connector versions live outside the application bundle. Desktop retains bundled tethered runtimes before replacing itself, even with connector automation off or a pin set. Signed independent releases are staged beside the previous version. Encrypted receipts and a transition journal record the exact previous config/executable; startup or discovery failure rolls back. Uncertain calls are never replayed. Failed automatic releases require manual retry. Unexpected configuration edits block recovery rather than overwrite user changes.

The canonical shared-runtime coordinator pauses all participating Desktop/CLI owners under an exclusive lease. New dispatch returns a retryable not-started result. Connector releases cannot replace shared native/browser runtimes or install extensions. New host/runtime or permission/configuration requirements stay pending for user action.

## Release qualification

Desktop accepts a signed `releases/stable.json` index with monotonically increasing sequence and immutable release entries, and retains legacy signed manifest compatibility. Entries select target/distribution and can use platform-specific tags. Automatic application additionally requires the signed entry's `qualified` array to contain the target/distribution and acceptance evidence SHA-256. Legacy manifests remain manual until qualified through an index.

Use `apps/desktop/scripts/sign-update-index.mjs <index.json> <key.pem> <new-output.json> <evidence-directory>`. Evidence is named by its hash and must cover the exact commit/artifact and every check exported by `update-acceptance.mjs`. Source distribution evidence identifies the exact source commit and built artifact. Connector catalogs are independently signed by the MCP Library's local tooling. No GitHub Workflows are used.

Required native rows: Desktop source and ZIP on macOS ARM64/macOS x64/Windows x64; Windows Squirrel; each connector mode/platform published in its catalog. Include interrupted downloads, exhausted disks, file locks, crash recovery, rollback, active/queued-call races, sleep/wake and resumed activity, concurrent owners, retained credentials/permissions, and pinned-version survival. Unit tests or a package build alone do not qualify any row. Missing native evidence stays explicitly unqualified, with no production activation.

## Implementation validation (2026-11-05)

On macOS ARM64, Desktop source verification passed type checking, all 421 tests in 69 files, and the production build. Tests cover the default-off gates, preference persistence and pinning, cancellation, countdown/resume/postponement, signed metadata and artifact rejection, ownership enrollment, immutable retention, maintenance races, cross-process coordination, rollback, and the rendered update controls. The CLI additionally exercises replacement and rollback using real MCP child processes.

The isolated native harness passed source 0.1.26 → 0.1.27, injected-failure rollback, and verified ZIP 0.1.26 → 0.1.27 without Git/Node/pnpm on the update path. It checked packaged startup and profile preservation. The Node/Electron ASAR filesystem harness passed copying, hashing, tamper detection, and removal.

These results are development evidence, not release qualification. Windows ZIP/Squirrel, Intel Mac, and the complete per-connector native acceptance matrix have not run here. Full disk-exhaustion, native locks, live credentials/browser sessions, and concurrent native Desktop/CLI owner acceptance are still required for the exact released artifacts. No platform row is marked qualified by this report, no stable feed has been published, and production automation remains disabled.
