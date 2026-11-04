# Bitwarden credential access

Laplace Desktop uses selected Bitwarden Password Manager logins without returning their secret fields to an agent. Agents call `local_credentials` through the desktop MCP bridge, or `use_local_credential` through the hosted Laplace MCP. The desktop must be running. Both paths are off by default.

## Guided setup

Open **Laplace Desktop → Settings → Bitwarden → Connect Bitwarden**. The guided flow is:

1. **Connect:** choose your Bitwarden region (US or Europe), or your self-hosted HTTPS server. Laplace prepares the official Bitwarden CLI privately; no terminal, global installation, or browser extension is needed.
2. **Sign in:** enter your email and master password in Laplace, then complete any verification-code prompt. For unsupported second factors or an additional Bitwarden account check, the wizard offers a guided personal API key fallback. A master password is still required. Passkey-only and trusted-device-only accounts are unsupported.
3. **Choose logins:** search by name or website and select the logins to share, or choose **Select all logins** to add every current login in one step (including logins outside the search). Existing selections and configured actions are preserved. New vault entries are not selected automatically; refresh and select all again to include them. Up to 10,000 selected logins are supported. Selections save automatically and keep the current vault session unlocked. Raw passwords, notes, and vault exports are never shown to an assistant.
4. **Choose assistants:** select registered local assistants. If an assistant restricts individual tools, selecting it also enables its credential tool. Online assistants are a separate opt-in and require a linked account and deployed relay support.
5. **Set up a browser**, or choose **Set up browser later**. This step is optional for API/command use.

The overview provides **Unlock**, **Manage access**, **Lock Bitwarden**, and **Disconnect**. The account stays signed in locally, but the vault locks after at most 15 minutes, on computer lock/sleep, profile switching, or application exit. The master password is never saved. Permission changes cancel outstanding approvals and revoke remembered grants without requiring another unlock; connection changes still lock the vault.

Laplace uses an isolated Bitwarden CLI profile under each desktop profile. Disconnect removes only that isolated CLI session and disables access; saved login selections remain. Existing externally configured CLI connections stay intact and can opt into guided setup. Switching accounts while selections are bound to a known account is refused until those selections are removed. No external Bitwarden application is logged out or modified.

### Browser connection

**Use an existing browser** discovers compatible Chrome/Edge processes owned by the current user that already expose explicit local debugging configuration. Laplace validates their endpoints and asks you to select a session; it does not scan arbitrary ports or enable debugging on your usual browser.

**Open a compatible browser** launches installed Chrome or Edge using a separate persistent Laplace profile and a dynamic loopback debugging port. Laplace closes its own browser on quit/profile switch; external browsers remain open. Closing or locking the Bitwarden vault does not erase that browser's website sessions. If no supported browser is installed, the wizard links to the official downloads.

“Browser available” means Laplace can reach the browser. Your assistant must also attach its existing browser tools to that session. **Copy instructions for my assistant** helps a local assistant obtain the selected endpoint through the authorized MCP status tool. Hosted agents never receive the endpoint. Cloud-only browsers and tools that cannot attach to local CDP remain incompatible.

Chrome requires a non-default profile for debugging; see the [official guidance](https://developer.chrome.com/blog/remote-debugging-port). The separate Laplace profile meets that requirement.

Browser fills still require an exact origin present in both the selected login and its current Bitwarden HTTPS URLs; “Never” entries are excluded. Only unambiguous visible top-level fields are filled. Cross-origin form actions and frames are refused, and Laplace never submits forms. Other browser tools and the destination website can read filled values.

### Advanced configuration and runtime maintenance

Manual CDP addresses, existing CLI path overrides, credential IDs, and API/command JSON are under **Advanced settings**. The managed Bitwarden runtime is pinned to version 2026.10.0. Its complete dependency lockfile lives in `apps/desktop/runtime-manifests/bitwarden`; every dependency is pinned to registry.npmjs.org with SHA-512 integrity. Installation uses the bundled Node/npm, an isolated cache/configuration, no global writes, and disabled lifecycle scripts. Release updates must update the manifest and expected CLI integrity/version together and rerun native acceptance. No user npm configuration or credentials are consumed.

## Requests and approvals

Use a fresh UUID `requestId` per operation. Local clients call `status`, `list`, and `targets`, then `fill`, `http`, or `run`. Large `list` results are paginated; pass `nextCursor` as `cursor` with a new request ID until it is absent. Restart from the first page if selections change. Hosted agents first call `devices` and include its `installationId`, plus `accountId` when multiple accounts are authorized. Hosted operations return immediately; poll `result` with the same request ID. New hosted agents need approval even to list selected credentials or targets.

Review requests in Settings and choose Allow once, Allow this scope for 15 minutes, or Deny. Grants bind the authenticated client, credential/action, and exact parameters; browser grants also bind the tab and fields. Grants never outlive the unlocked session. MCP cannot unlock, approve, change settings, or configure actions. Existing local tool restrictions still apply.

Requests expire after two minutes. Cancellation cannot undo side effects already performed. Check uncertain outcomes before retrying with a new ID. Identical retries reuse retained results, and changed-input retries are rejected. Local encrypted request tombstones last 24 hours; hosted tombstones last until installation removal. Work is never automatically replayed after restart or relay failure.

Example fill (replace identifiers with discovered values):

```json
{
	"action": "fill",
	"requestId": "00000000-0000-4000-8000-000000000001",
	"credentialId": "00000000-0000-4000-8000-000000000002",
	"targetId": "TAB_ID",
	"fields": ["password"]
}
```

## Configured actions

Advanced settings accepts trusted API/command action definitions. Use a fresh action UUID and a selected credential's handle. Agents may only choose explicitly listed parameter values. `{{name}}` substitutes a parameter in command arguments or HTTP JSON body values; HTTP URLs are fixed. Only explicitly selected top-level scalar JSON fields are returned, defaulting to status/exit code only. Raw stdout/stderr, response headers, non-JSON output, and nested values are discarded.

```json
[
	{
		"id": "00000000-0000-4000-8000-000000000003",
		"label": "Read account status",
		"credentialId": "00000000-0000-4000-8000-000000000002",
		"kind": "http",
		"url": "https://api.example.com/account/status",
		"method": "GET",
		"header": "Authorization",
		"prefix": "Bearer ",
		"field": "custom:api_key",
		"parameters": {},
		"resultFields": ["status"]
	},
	{
		"id": "00000000-0000-4000-8000-000000000004",
		"label": "Read trusted project status",
		"credentialId": "00000000-0000-4000-8000-000000000002",
		"kind": "command",
		"executable": "/absolute/path/to/trusted-cli",
		"cwd": "/absolute/path/to/project",
		"args": ["status", "--project", "{{project}}", "--json"],
		"env": { "SERVICE_API_KEY": "custom:api_key" },
		"parameters": { "project": ["demo", "staging"] },
		"resultFields": ["status"]
	}
]
```

HTTP requires public IPv4 HTTPS, pins the checked DNS address, and does not follow redirects. Authentication supports Authorization or X-\* headers. Private-network/IPv6-only destinations and credential-in-URL authentication are unsupported. Commands require absolute executable/cwd paths, use argument arrays without a shell and a minimal environment, and receive only selected fields. Execution lasts at most 60 seconds; output is capped at 64 KiB. Executables must already be installed.

## Hosted rollout

Before deploying the updated connector, apply the `20261023200000_local_credentials` migration and its generated database security policies. Existing Prisma reads select the new installation column even when the relay flag is disabled. With the explicit production owner `DIRECT_URL`, run `pnpm --filter @repo/database deploy:local-credentials` for a transaction rollback rehearsal, then add `--apply` to commit the verified additive schema and feature-scoped policies. The script rejects partial migrations, verifies payload bounds and installation ownership, and audits database security. Deploy the connector and desktop afterward. Enable `ENABLE_LOCAL_CREDENTIALS=true` alongside `ENABLE_LOCAL_MCP=true` only after acceptance; the relay remains opt-in. No migration is run by the desktop.

Link the desktop to the account and enable hosted requests locally. Its installation credential authenticates outbound polling; no inbound public endpoint is opened. Hosted requests require a `connections:use` OAuth grant with unrestricted connection selection, a live user session, current membership, and installation ownership. The helper reauthorizes immediately before execution and checks pending jobs for revocation. Revocation cannot undo an already-issued request or fill.

This relay is separate from metadata-only local-MCP publication. It stores references, action parameters, and sanitized results, never Bitwarden passwords or unlock tokens. Completed jobs discard their input and OAuth grant metadata; stale payloads are cleared on subsequent requests after a ten-minute grace period. Disabling the backend flag blocks hosted requests; local-only access remains available. Removing an installation cascades relay records.

## Security boundary and verification

Laplace does not return raw credentials, but the destination site receives filled values and a configured executable receives injected environment variables. Another extension or agent with browser access may read filled fields; Laplace cannot redact those other tools. Known raw, URL-encoded, JSON-escaped, hex, and base64 values are filtered from selected output, but arbitrary transformations cannot be made safe by redaction. Choose trusted destinations, commands, and result fields. The unlocked local machine and its executables are inside the trust boundary.

Automated tests use synthetic credentials, mocked sign-in prompts and IPC, and real Chromium browser filling. The guided UI, isolated CLI installation, and separate Chrome launch have also been exercised on macOS. Real Bitwarden sign-in still requires acceptance with a disposable vault; hosted end-to-end acceptance requires a migrated test backend. Windows native runtime/package acceptance remains pending. The legacy `laplace-local` wrapper is unchanged; this feature uses Laplace Desktop and its bridge.
