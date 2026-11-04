# Portable desktop connectors

Implementation is additive to remote main `8f09df0bc18ab7562afa0fe7d40935e57ce764a4`.
The [user story](portable-connectors-user-story.md) defines the product behavior.
The feature remains off until the deployment prerequisites below are in place.
Native two-device testing is optional and is not a rollout requirement.

## Identity, access, and installation

Each installation receives its own `pc_<uuid>` ID and runtime directory. Legacy
IDs remain valid. Copies record their source connection/device and retain their
own settings and authentication profile. Catalog and custom MCPB requests, bulk
selection, local agent tools, and hosted management share `PortableConnectors`.
The encrypted operation journal stores request identity, stages, receipts, and
local artifact references. It does not retain supplied credentials. A duplicate
key returns its existing operation; changed input with the same key is rejected.
Retries reconcile actual installed state and recollect settings. Helper restart
marks in-flight work interrupted and never replays provider actions.

| Setting                    | Remote listing | Remote invocation             | Copy |
| -------------------------- | -------------- | ----------------------------- | ---- |
| Available remotely         | Visible        | Authorized, online host only  | Yes  |
| Keep local                 | Visible        | Blocked                       | Yes  |
| Keep local + Hide remotely | Hidden         | Blocked, including cached IDs | No   |

New instances are Keep local and visible after linking. Existing local-only
instances retain their prior privacy. Unhiding does not enable execution.
Installation, settings, authentication, verification, and readiness are separate
states. Bulk items succeed or fail independently; cancel/retry operates per item.
Repair restores the exact pinned archive and verifies it without selecting a
new catalog version. Existing client registrations and hosted connectors remain.

Custom imports support MCPB 0.1/0.2/0.3 manifests with Node, Python, or bundled
binary stdio servers and scalar configuration. Unsupported types/constraints
fail before starting the connector. Scalar fields validate numeric bounds; multi-value
configuration is rejected explicitly. Platform overrides and Windows binary suffixes
follow the [MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md). Node constraints are checked against the
helper runtime; Python minimum-version constraints are passed to bundled uv.
Bundles are bounded to 64 MiB and use existing safe ZIP extraction. Required
credentials are entered on the destination. Generic bundles without a provider
adapter use their own instructions; verification confirms MCP discovery, not a
provider-specific read. Catalog adapters retain their provider sign-in checks.

## Portable data

Snapshots include a schema version, bundle identity/version, integrity hashes,
compatibility, and approved nonsensitive settings. Catalog settings are limited
to workspace/provider identity, with credential-bearing URLs rejected. Custom
settings are recollected. Session directories, browser profiles, cookies,
credentials, local files, launch environment, and device paths never enter the
snapshot. Only the original custom MCPB archive is uploaded; installed runtime
and authentication directories are never uploaded.

Custom archives live in the existing storage abstraction's private
`portableBundles` bucket, under a user/workspace-specific hash prefix. Signed
URLs expire after 60 seconds. Ready-to-copy requires a synced snapshot and
artifact. A visible source may be offline or Keep local; the target must be
online. Hiding/removing the source prevents new remote copies. Existing copies
remain independent. V1 uses the reviewed pinned catalog snapshot and rejects
unavailable versions instead of substituting an upgrade.

## Remote execution and agents

`LocalMcpRelay` is separate from `LocalMcpEvents`. One authenticated outbound
WebSocket belongs to each registered desktop. Hibernating socket attachments
recover host identity. Calls are transient, bounded to 1 MiB, limited to 32
in-flight requests per desktop, and time out after three minutes. Host loss,
revocation, cancellation, and eviction never cause automatic replay; ambiguous
outcomes explicitly require inspection. Both worker configurations enable
[request cancellation and signal forwarding](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests).

Live tool schemas and tool arguments/results traverse Laplace only for explicit
remote execution. They are not stored in the relay, operation journal, snapshots,
or logs. The backend checks ownership, membership, visibility, remote enablement,
and tool permissions/revision. The host checks these again at dispatch and gets
fresh cloud authorization. Disabling the feature blocks new cloud dispatch.
Metadata-only `desktop.relay` events report kind, outcome, and duration;
`desktop.access_denied` reports permission failures. Operation receipts and
`portableReady` support completion and copy-readiness monitoring.

Local agents can wrap any action as `{idempotencyKey, command}` to retain its
receipt across restarts; use the returned `operationId` as `jobId` for status.
Local agents retain `local_connectors_*` and gain `local_connectors_manage` for
imports, bulk setup, configure, access, retry, cancel, repair, and removal.
`local_connectors_list` also returns visible peers; use `{action:"copy", sourceId,
idempotencyKey}` to copy onto the running helper. Native Desktop exposes the same
other-device inventory and copy dropdown. Hosted
agents use `desktop_connectors_list`, `desktop_connectors_manage`, and
`desktop_connectors_status`. Copy requests identify source and target explicitly.
`desktop:manage` is a separate opt-in OAuth scope, requested through Desktop's
**Authorize desktop management** action or an OAuth client requesting that scope.
Existing grants/default scopes do not gain it. Tool use still requires
`connections:use` plus current connection/tool permission. Use
`connectionName: desktop:<connection UUID>` with `search_actions`,
`get_action_guide`, or `execute_action`; execution reports the selected host.

Management requires an online target and is never queued for an offline device.
Authentication opens on that device. Poll operation status after user action.
Normal AI-client configuration writes the plugin's nonsecret bridge descriptor
and checks MCP discovery; restarting the actual client may still be required.
Manual configuration remains available as a fallback.

## Deployment order and prerequisites

1. Apply additive schema and generated RLS policies using
   `pnpm --filter @repo/database deploy:portable-connectors`. It requires an
   explicitly supplied deployment `DIRECT_URL`, runs an audit, and rolls back
   by default. Use `--apply` only as part of an authorized deployment. Do not use
   Prisma schema push against production.
2. Provision a private bucket accessible through the existing S3-compatible
   storage credentials. Set `PORTABLE_BUNDLES_BUCKET_NAME`; never make it public.
3. Deploy the `apps/local-mcp-events` additive Durable Object migration. Keep the
   existing events namespace. Record the new namespace in the release resource
   manifest as `localMcp.relay = {workerName: "laplace-local-mcp-events",
namespaceId: "<audited namespace ID>"}`. Release binding verification includes
   both namespaces and the existing hosted MCP namespace.
4. Deploy API/desktop capabilities with `LOCAL_MCP_PORTABLE_ENABLED` disabled.
   Older clients retain their original interfaces; management is available only
   when the target has an active relay connection.
5. Set `localMcp.portableEnabled: true` in the reviewed release resources after
   the relay/storage/schema prerequisites are deployed and automated checks pass. Monitor
   operation outcomes, ready-to-copy counts, relay availability, permission
   failures, and interrupted calls. Disable the flag to stop new remote work;
   local operation and existing data remain available.

## Verification

Automated tests cover isolated helpers with real fixture MCP processes, fresh
copy credentials and profiles while the source is stopped, independent IDs,
source removal, idempotency, repair/retry, visibility, bulk partial failure, and
native plugin descriptor generation. API tests cover online-only management,
scopes, hidden/direct IDs, revoked grants, snapshot validation, and uncertain
outcomes. An isolated Chromium test exercises online target selection, copying a visible
offline source, and access controls with fixture API responses. The Miniflare
relay suite uses two WebSockets and exercises hibernation,
isolation, host loss, cancellation, and revocation. PGlite applies the additive
migration twice and checks defaults, unique requests, and RLS isolation.

Additional native or two-device testing can be performed as needed, but does not
block implementation completion or rollout. Record the actual platforms and
validation scope when performed; fixture results do not claim native provider
sign-in or production deployment.

### Portable implementation validation (November 1, 2026; before worktree integration)

- Desktop build and full suite: 207 tests passed across 31 files, including built
  renderer checks in Chromium.
- Local MCP, connector MCP, and hosted connector API suites: 246 tests passed
  across 23 files.
- Browser copy/access flow and Miniflare relay integration: 2 tests passed.
- Release checks: 136 tests and 4 Worker runtime tests passed.
- Database security checks: 23 passed; 32 live-database tests skipped because no
  disposable database was configured. The isolated PGlite migration/RLS test passed.
- API, Desktop, browser type checks, changed-file lint, environment catalog,
  generated database security outputs, and diff whitespace checks passed.
- Upstream rechecked at `8f09df0bc18ab7562afa0fe7d40935e57ce764a4`.

### Integrated deployment preparation (November 1, 2026)

Portable connectors, the Slack browser adapter, and Laplace Point are combined in
`codex/integrated-desktop-release`. Original worktrees and a recoverable snapshot
remain intact. Desktop version 0.1.4 preserves pinned Slack bundles; the browser
adapter requires `LAPLACE_BROWSER_CONNECTION_ENABLED=true`, and Point is opt-in.

The production additive migration passed a rollback rehearsal and was applied
with schema verification and the full security audit. The audit preserves only
the exact reviewed retired Profiles table and hosted-installation policy aliases;
all other inventory, policy, and privilege checks remain active. The existing
server passed its read-only production smoke check after migration.

The private `laplace-portable-bundles` bucket and `LocalMcpRelay` namespace are
provisioned. The relay Worker has no public routes, workers.dev URL, or preview
URL. The separate events namespace is provisioned without activating its binding.
The relay namespace is recorded in the production resource manifest, with
`portableEnabled: false`. Before activation, verify the existing S3 credential's
access to the private bundle bucket and the supported Desktop release. Native
two-device testing is optional and is not a release or activation gate.
