# Streamlined connection setup — implementation and acceptance

Implemented on `codex/streamlined-credentials` in the Desktop and backend worktrees. Desktop candidate: 0.1.21; bundled Chrome extension: 0.6.0. No production deployment or installed-client replacement was performed for this change.

## Behavior

- Credentials is a dedicated native sidebar destination in standalone/offline and compatible signed-in shells. Existing native Credentials navigation still reaches it. Connections, AI clients, Device, and Updates remain under On this device.
- Credentials groups Bitwarden, assistant access, Chrome readiness, Doppler guidance, and recent requests. CLI overrides, legacy CDP, and command actions remain Advanced. Doppler scope editing continues through existing Laplace Connections controls.
- Broker sessions expose metadata-only readiness actions. Untouched unlinked drafts can bind once to the account the user links; reviewed or attempted requests cannot switch accounts. Assistant authorization can be completed without losing the request.
- MCP Apps support credential changes, field mappings, exclusions, focused local unlock, immediate approval feedback, and automatic status updates. The helper advances approved login steps and verifies the connection without an assistant continuation message. Legacy clients retain Desktop review.
- OAuth can start in the existing Chrome profile with no credential mapping or vault access. Saved-login use requires one fresh mapping approval. Extension site permission, MFA, passkeys, CAPTCHA, and consent remain user-controlled.
- Submissions have durable receipts; uncertain advances are recorded and never automatically resubmitted. Cancellation, lock, expiry, revocation, restart, and account ownership checks remain enforced. Reauthentication does not replay a failed business action.
- Local connectors without Chrome-extension login support explicitly fall back to their manual setup. No new secret store, arbitrary browser interface, or standing reauthentication grant was added.

## Automated verification

- Desktop: 55 test files, 352 tests passed, one pre-existing skip. Final affected broker tests: 32 passed, including actual MCP App iframe routing for local and hosted tools, focused-unlock continuation, automatic completion, approval isolation, and uncertain submission handling.
- Project protocol: 109 tests passed.
- API and gateway: 88 affected tests passed.
- Connector sidebar, native routes, and MCP ingress: 30 tests passed.
- Desktop, project-protocol, API, and connector type checks passed. Connector type checking required a 6 GB Node heap.
- Windows package smoke passed at normal and 150% device scaling; card containment was checked at 100%, 125%, 150%, and 200% UI zoom. Signed-out configuration, signed-in persistent sidebar, native navigation, window lifecycle, and MCP clients were exercised with disposable profiles.
- Packaged Windows native acceptance passed: keychain, encrypted restart, bundled Node/plugin launcher, helper restart, concurrent/repeated bridge connections, uncertain write exactly once, and cleanup.
- Synthetic form tests exercise eligible password filling and block unsupported forms/challenges. Canary checks cover model/card output and sanitized failures. These do not constitute a live provider password-fill acceptance.

## Release order and remaining live acceptance

1. Deploy the compatible API/gateway/protocol and connector UI changes first. Relay version 2 accepts credential-free broker work while legacy secret operations retain opt-in. This change requires no database migration.
2. Publish Desktop 0.1.21 and Chrome extension 0.6.0. Reload unpacked extensions and cached MCP connections as necessary. Keep `ENABLE_CREDENTIAL_BROKERING` as the existing rollout gate.
3. Verify the actual chat host, one new connection and one reconnect using an existing Chrome session, and the locked-vault → focused unlock → same card → approval → verified connection sequence.
4. Perform a separate user-approved live password-fill test with a naturally signed-out provider. Do not sign the user out to manufacture the test. Prior Google and TikTok tests reused existing sessions and did not validate live password injection.
5. Run native macOS acceptance on a Mac. Shared layout and browser tests passed here, but this Windows environment cannot establish native Mac acceptance.

Windows candidate directory: `E:\LaplaceBuilds\desktop-layout-0.1.15\apps\desktop\out\Laplace-win32-x64`.
