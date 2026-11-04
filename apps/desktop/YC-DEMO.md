# YC connector demonstration

The Y Combinator entry is **Demo Only**. It is a local MCP served by Laplace
Desktop, using the same approved-tab browser connection as Slack. It is not a
hosted YC integration and does not use Cloudflare Browser Run for sign-in.

## Setup

1. Build Desktop with `pnpm --filter @repo/desktop build`. Its runtime includes
   `helper/yc-browser.cjs` and Browser Connection extension 0.3.1.
2. Install `ycombinator-demo` through `local_connectors_install`. There are no
   configuration fields, Chromium downloads, credentials, or cookie imports.
3. Sign in to YC in normal Chrome or Edge. Run `local_connectors_authenticate`,
   then open the Laplace extension on that YC tab. Review the account and approve
   reads and draft saves. The same eight-hour/tab-scoped approval as Slack applies.
4. Keep Desktop and the approved tab open. Verification only reads visible
   applications. Open the application you want to demonstrate in that tab.

An existing Desktop version can also attach the built, standalone
`yc-browser.cjs` using `local_connectors_add_custom`, Node as the command, and
the absolute script path as its argument. Name it `Y Combinator · Demo Only`.
Enable only `connect_browser`, `list_applications`, `read_application`, and
`save_draft`. Call `connect_browser` to publish the same extension approval
request. Do not register the child MCP separately in the AI client.

## Video walkthrough

The Desktop MCP also exposes `render_yc_application` and the embedded MCP Apps
editor. Refresh the AI client's Laplace tool catalog after upgrading Desktop,
reload Browser Connection 0.3.1, and approve the YC tab again. The editor requires
the catalog-installed YC connector identity or a legacy custom connection running
an exact copy of Desktop's bundled YC adapter through its bundled Node runtime,
and the client's existing YC read permissions. Update legacy copied adapters when
upgrading Desktop. Preview and save additionally use its existing save permission.
Multiple YC connections require selection. Resources disappear when access is
revoked; generic connector tools remain model-only.

ChatGPT suggestions remain unsaved until review and an explicit save. Local
drafts survive navigation inside the mounted editor, but not chat reloads.
Reads verify persisted YC answers in a fresh same-origin frame, including after
an uncertain save; the editor never automatically repeats a write. Desktop and
the approved application tab must remain open. Uploads and submission stay on YC.

Show Y Combinator's Demo Only listing, then ask your agent to:

- List the applications visible in the approved tab.
- Read the open application's answers.
- Preview a specific text edit using the returned revision.
- Save that exact edit with `confirm: true`, then show the saved answer in YC.

Draft saves modify the real application. Default calls only preview. A stale
revision or unsaved manual form changes block saving. The adapter clicks only
Save changes once and verifies the persisted response. Uncertain saves must be
read again before retrying. No tool submits applications, uploads videos, changes
founder profiles, or reads the product-login-credentials field.

This prototype operates on the visible application. Navigate the approved tab
normally to switch applications or list them from YC home. Site markup changes,
expired sessions, or provider validation can still interrupt the demo; these are
reported as errors, never simulated successes.

## Verification

`pnpm --filter @repo/desktop test` covers catalog setup and approval boundaries.
Run the real Chromium fixture with an explicit executable path:

```
cd apps/desktop
node tests/yc-extension.browser.mjs /path/to/chrome
```

The fixture verifies zero preview writes, one confirmed save, persisted answers,
stale revision rejection, manual checkbox protection, and no submit action.
Live YC acceptance requires the user's extension approval and is separate from
the fixture.
