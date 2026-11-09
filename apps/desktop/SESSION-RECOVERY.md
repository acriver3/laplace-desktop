# Session recovery candidate

Set `LAPLACE_SESSION_RECOVERY_V1=true` in the Desktop environment to opt in. Desktop forwards this flag to its helper and maintained Outlook connector. The default is disabled. Existing browser rollout gates, connector defaults and opt-in migrations remain unchanged.

Recovery status distinguishes transient transport errors, provider rate limits, missing tabs, confirmed sign-out and changed approval. Only connection establishment and designated verification reads retry, with single-flight execution, bounded jittered backoff and provider retry delays. Startup, helper restart, extension reconnect, resume and network restoration trigger recovery. Eight-hour transport expiry renews through the existing consent flow only for the same approved account, profile, client and scopes. Closed tabs remain closed; interrupted user writes are never replayed. Disconnect and revocation remain persistent.

Managed catalog configuration already rejects session/profile directories inside installed connectors. Separate profile paths, imported connections and installer rollback behavior remain intact. No accepted managed legacy configuration requiring profile migration was found; unsupported bundle-contained profiles are not silently relocated.

The Outlook background connector 0.5.0-laplace.2 (now the npm release; recovery stays behind `LAPLACE_SESSION_RECOVERY_V1`) serializes refresh per account, atomically persists encrypted token rotation before releasing callers, preserves omitted refresh tokens and distinguishes revocation from transient errors. Earlier bundle installations move to the npm release as described in [automatic updates](AUTOMATIC-UPDATES.md). Browser-owned credentials stay in the browser. Hosted-client OAuth is unchanged. Runtime 0.4.3 and extension 0.7.2 propagate safe provider recovery metadata; older extensions remain compatible.

Validation covers both flag states, eight-hour renewal, account/profile/scope changes, revocation, restart/resume/network events, provider delays, absent tabs, concurrent OAuth refresh, rotation, failed persistence and interrupted writes. Packaged macOS Electron, native bridge and real Chrome extension tests passed using disposable synthetic profiles. Native Windows acceptance and an internal-user trial remain required before activation. No production activation is part of this change.

Local diagnostics retain at most 50 recovery records containing bounded failure categories, attempt counts and timing, without credentials, message content or account identifiers.
