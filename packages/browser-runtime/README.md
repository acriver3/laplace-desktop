# Browser runtime candidate

This is the canonical source for Laplace's Slack, YC, and candidate Outlook extension connection. Desktop vendors the exact source revision and SHA-256 inventory in `source-lock.json`; its build verifies that inventory before packaging. This candidate is not a complete tethered connector release.

The runtime has no Electron dependency. `BrowserApprovals` receives a host and consent store; Desktop supplies its existing manager and encrypted storage. `openBrowserApprovalPage` provides a request-scoped, CSRF-protected loopback approval UI used by the standalone CLI. Desktop and CLI use the same approval card and serialized consent checks.

## Compatibility

- Native discovery protocol: 1, existing extension ID and native host name unchanged.
- Extension: 0.7.0. Existing Slack/YC scopes and consent revisions are unchanged.
- Chunked transfer: optional, advertised per invocation through `resultLimit`. The new extension uses the previous JSON path with older relays. Old extensions continue to handle the existing small Slack/YC operations.
- Public setup URLs are independent of immutable historical MCPB documentation.

## Shared native installation

`LAPLACE_TETHERED_BROWSER_V1=true` enables the candidate native registration path. It is off by default. Once a shared installation exists, updated clients retain that path even when the flag is off, preventing an accidental return to a client-owned executable.

The native runtime is copied into `~/.laplace/browser/runtimes/<version>-<digest>`. Desktop and CLI ownership is tracked separately. Compatible older clients keep the newer installed version; incompatible protocols and different bytes under the same version are rejected. Both clients must distribute the same reviewed native assets for a given platform/version. Releasing one owner retains the independent executable and the other owner's registration. Last-owner release retains the shared runtime for recovery.

Registration is serialized. A crashed installer leaves a lock and fails closed; after confirming that no installer is running, the user can remove `~/.laplace/browser/installation.lock` and retry. A failure while registering native manifests preserves the monotonic version and copied files so registration can be retried without downgrading.

## Attachment transport

Registered operations may opt into larger `maxInputBytes` and `maxResultBytes` limits. Defaults remain 1 MiB; each direction is capped at 32 MiB per invocation and 64 MiB across pending transfers. Transfers use 192 KiB chunks, ordered byte counts and SHA-256 checksums. All chunks require the existing extension origin and connection token, and are bound to a delivered invocation. Cancellation, expiry and disconnect discard pending transfers. A delivered write with no verified result remains uncertain and is never replayed.

The candidate Outlook adapter retains all original tool registrations and opts attachment operations into bounded transfers. Its build substitutes browser transport without bundling the original token cache or Playwright authentication.

## Release gates still outstanding

- Packaged Desktop and CLI acceptance. Candidate macOS ARM64 live reads passed for Outlook status/folders and Slack identity/channels; see `evidence/2026-11-05-darwin-arm64-live-reads.json`. This records the exact connector artifacts and approval-page source override, not a blanket release acceptance. LinkedIn keeps its original background-browser implementation.
- Final standalone CLI and Desktop migration/release integration.
- Real installation migration acceptance. Fixture tests exercise staged artifacts, fresh consent, unchanged IDs/permissions, cancellation, interrupted migration, duplicate prevention, explicit imported-config migration and recovery.
- Common immutable native/connector release artifacts and checksums for every supported platform.
- Designated-account write acceptance. Writes have only been exercised against fixtures; the live acceptance checks were read-only.
- Physical Windows/Linux native registration, upgrades and uninstall checks. Windows registration tests use a registry stub; macOS/Linux path behavior is tested with temporary homes.

Keep catalog selection and new execution disabled until these gates pass. Existing MCPB releases retain their versions and dedicated/background browser behavior.

The local builder emits `browser-runtime-manifest.json` with the target platform, source revision, compatibility versions and checksums of every packaged connector, native entry and extension file. CLI packaging rejects a platform mismatch or changed artifact. Native Windows launchers must be built on Windows. Do not activate `LAPLACE_TETHERED_BROWSER_V1` or the web `NEXT_PUBLIC_LAPLACE_TETHERED_BROWSER_V1` flag for release until the remaining gates pass.

Extension 0.7.0 also preserves the credential sign-in broker from Desktop main `cfb2d15`. Its optional HTTPS site permission is requested for one explicit approved sign-in origin; it does not broaden Outlook or Slack connector operations. CLI and Desktop distribute the same extension. The earlier live-read evidence used extension 0.6.0 before this compatibility integration.
