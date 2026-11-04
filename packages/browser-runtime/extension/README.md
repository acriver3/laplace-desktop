# Laplace Browser Connection

Connect existing signed-in browser accounts from an MCP agent without opening the extension popup.
The adapter remains opt-in through LAPLACE_BROWSER_CONNECTION_ENABLED=true.

## Setup and use

1. Install or reload the bundled extension in Chrome or Edge. Version 0.4.0 requires accepting site access for Slack, Slack Gov and apply.ycombinator.com. It does not request all-sites, cookies or debugger access.
2. Ask the agent to connect a catalog service. It calls local_connectors_authenticate, polls local_connectors_status, then calls local_connectors_browser_show with browserApproval.requestId.
3. Review the account, workspace, browser profile and scopes in chat and select Approve connection. Multiple matches require account selection. Desktop verifies a provider read before reporting Connected.
4. If no matching tab exists, discovery waits without opening a tab. Clicking Finish signing in opens the provider's allowlisted URL or brings an existing tab forward in the selected profile. Installation permissions and provider login/MFA still happen in the browser.
5. Hosts without MCP Apps use local_connectors_browser_desktop for the same request-specific review in Laplace Desktop.

The popup lists active connections and Disconnect; no pending-request picker is needed.
The consent card also supports cancellation and disconnect. Keep the browser running;
closing a tab pauses access until the exact approved account returns. Background retries,
ticket renewal and Desktop or extension restarts never reopen closed tabs. This rule applies
to every provider; remembered consent permits reconnection to existing tabs, not opening them.

## Consent and transport

The extension connects to com.laplace.browser with watch_pending at startup. The native
host streams bounded, short-lived tickets, and cannot approve or execute provider tools.
A retry timer and alarm recover the subscription. Each profile has a random installation
ID stored locally (never synced). Only matching provider tabs receive identity checks.

Desktop owns consent. Extension identity reports are shown in a bundled MCP App; approval
capabilities exist only in UI metadata and are bound to client, request, candidate and
revision. They expire after one minute and are consumed once. The relay requires a
separate Desktop authorization before accepting a single-use pairing ticket, and the
extension rechecks identity immediately before pairing and every provider action.
The app uses the MCP host bridge, not direct localhost requests.

Desktop stores remembered consent in its encrypted browser-consent document, keyed by
connection, initiating client, provider, workspace, account, profile and scope revision.
Transport credentials stay temporary. Restarts or eight-hour credential expiry cause
fresh discovery and identity verification; matching consent renews access without a new
prompt. Different accounts/profiles or expanded scopes need approval. Disconnect,
connection removal, or client permission revocation stops reconnection. Browser credentials
never leave the browser, and writes are never replayed on reconnect.

## Compatibility and rollout

Ship extension 0.4.1 with the matching Desktop build. Existing unpacked installations need
Reload and acceptance of the new site permissions. An old extension cannot authorize the
new relay. Existing session approvals do not become permanent grants: the first use of the
new flow requires explicit approval. Existing connector restrictions are preserved while
adding only internal browser setup operations. No store publication or installed-app update
is performed by a source build.

## Validation

browser-approval.test.ts covers consent isolation, encrypted persistence, restart renewal,
stale identity, expiry, cancellation, permission revocation and one-shot browser focus.
browser-tab-lifecycle.test.ts runs the shared worker for YC and Slack to cover passive discovery,
tab closure, renewed tickets, explicit sign-in and reconnection to manually reopened tabs.
mcp-server.test.ts exercises
real authenticated MCP routing and the browser relay. browser-native.test.ts verifies framed
subscriptions and shutdown. slack-extension-smoke.mjs uses disposable registry registration,
a synthetic Slack origin, the real extension worker and bundled native host, and an independent
minimal MCP Apps host rendering the real approval card. The popup stays unopened. The same test
checks tab closure, ticket renewal and manual reopening in real Chromium. This is
not a claim of testing inside a live Codex chat or against a real Slack account.
