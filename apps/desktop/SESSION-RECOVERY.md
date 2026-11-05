# Session recovery candidate

Set `LAPLACE_SESSION_RECOVERY_V1=true` in the Desktop helper environment to opt into this candidate. The default is disabled. No existing browser rollout or migration gate is changed.

The candidate adds recovery status to catalog jobs and browser approval views, preserves enabled state during verification, retries designated verification reads on recognized transient transport failures, and backs off browser transport failures. Browser recovery reuses existing encrypted consent and never retries user operations. An optional rendezvous field enables extension 0.7.1 to distinguish an absent tab from a provider sign-out. Old extensions remain compatible but retain their old discovery hints.

Managed catalog configuration already rejects session/profile directories inside bundles. Existing separate profile paths, imported connections, and installer rollback behavior are retained. No legacy profile migration was added because no accepted managed configuration with that layout was found.

No OAuth refresh implementation was changed. Desktop's OAuth implementation is for hosted clients, excluded from this change. Original third-party connector refresh remains owned by those connectors; further refresh-token hardening needs connector-specific changes and release validation.

Validation: Desktop type check, full 385-test suite before the final expiry test, focused 33-test suite including eight-hour renewal and both flag states, and production build passed. Electron macOS smoke passed after provisioning bundled runtime assets. Windows recovery and packaged extension acceptance remain outstanding. No production activation or binary release is authorized by these results alone.

Remaining before full plan acceptance: end-to-end provider retry-delay propagation, connector-specific OAuth concurrency/rotation tests, explicit resume/network event tests, complete macOS/Windows packaged recovery acceptance, and an internal-user trial. Local diagnostics are bounded to 50 recovery records and contain reason, attempt count, and elapsed time only.
