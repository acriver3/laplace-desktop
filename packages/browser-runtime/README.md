# Browser runtime candidate

This is the canonical source for Laplace's existing Slack and YC extension connection. Desktop vendors the exact source revision and SHA-256 inventory in `source-lock.json`; its build verifies that inventory before packaging. This candidate is not a complete tethered connector release.

The runtime has no Electron dependency. `BrowserApprovals` receives a host and consent store; Desktop supplies its existing manager and encrypted storage. `openBrowserApprovalPage` provides a request-scoped, CSRF-protected loopback approval UI for a future standalone CLI integration. CLI commands and lifecycle integration are not implemented in this candidate.

## Compatibility

- Native discovery protocol: 1, existing extension ID and native host name unchanged.
- Extension: 0.4.2. Existing Slack/YC scopes and consent revisions are unchanged.
- Chunked transfer: optional, advertised per invocation through `resultLimit`. The new extension uses the previous JSON path with older relays. Old extensions continue to handle the existing small Slack/YC operations.
- Public setup URLs are independent of immutable historical MCPB documentation.

## Shared native installation

`LAPLACE_TETHERED_BROWSER_V1=true` enables the candidate native registration path. It is off by default. Once a shared installation exists, updated clients retain that path even when the flag is off, preventing an accidental return to a client-owned executable.

The native runtime is copied into `~/.laplace/browser/runtimes/<version>-<digest>`. Desktop and CLI ownership is tracked separately. Compatible older clients keep the newer installed version; incompatible protocols and different bytes under the same version are rejected. Both clients must distribute the same reviewed native assets for a given platform/version. Releasing one owner retains the independent executable and the other owner's registration. Last-owner release retains the shared runtime for recovery.

Registration is serialized. A crashed installer leaves a lock and fails closed; after confirming that no installer is running, the user can remove `~/.laplace/browser/installation.lock` and retry. A failure while registering native manifests preserves the monotonic version and copied files so registration can be retried without downgrading.

## Attachment transport

Registered operations may opt into larger `maxInputBytes` and `maxResultBytes` limits. Defaults remain 1 MiB; each direction is capped at 32 MiB per invocation and 64 MiB across pending transfers. Transfers use 192 KiB chunks, ordered byte counts and SHA-256 checksums. All chunks require the existing extension origin and connection token, and are bound to a delivered invocation. Cancellation, expiry and disconnect discard pending transfers. A delivered write with no verified result remains uncertain and is never replayed.

No current provider's attachment tools have been ported by this transport change. Provider adapters must register appropriate limits and preserve their tool schemas, permissions and outputs before release.

## Release gates still outstanding

- LinkedIn and Outlook extension adapters, complete Slack tool parity, and provider fixture comparisons.
- Standalone CLI installation, authentication, status, disconnect, MCP Apps integration and process lifecycle.
- Managed migration with fresh consent, unchanged IDs and permissions, recovery and explicit imported-config migration.
- Common immutable native/connector release artifacts and checksums for every supported platform.
- Real signed-in reads and designated-account write acceptance. Current tests cover fixtures, not live provider accounts.
- Physical Windows/Linux native registration, upgrades and uninstall checks. Windows registration tests use a registry stub; macOS/Linux path behavior is tested with temporary homes.

Keep catalog selection and new execution disabled until these gates pass. Existing MCPB releases retain their versions and dedicated/background browser behavior.
