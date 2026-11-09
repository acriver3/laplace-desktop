# Laplace Desktop

An Electron client for Laplace. Signed in, the window shows Connect itself — the same sidebar, pages, and settings as the browser — so there is one UI to maintain. The native **On this device** pages hold what only Desktop can do: local connections and the catalog, AI client registration, device settings, and credentials. They also serve signed-out and offline use. Custom, manual, imported, and Laplace catalog local tools work without a Laplace login; signing into the connector's provider is a separate step. Hosted Laplace tools and installation linking require Laplace sign-in. The manager owns one process per stdio server and shares it across registered AI clients. Closing the window keeps those processes running; **Close Laplace Desktop** leaves them to the Laplace Runtime, and **Stop Laplace Runtime** stops them.

For in-app updates from a locally built installation, see [Source updates](SOURCE-UPDATES.md).

## Install a downloaded release

Open the GitHub Releases page supplied by Laplace and choose the intended release. Download an attached **Laplace desktop ZIP** for your Mac and its `SHA256SUMS` file, rather than GitHub's source-code archives. Use `darwin-arm64` for Apple Silicon or `darwin-x64` for Intel. Check the release's validation notes: an Intel build tested under Rosetta is not a physical Intel Mac acceptance result.

1. Verify the downloaded archive against `SHA256SUMS`, for example with `shasum -a 256 <archive.zip>`.
2. Extract the ZIP and move **Laplace.app** to **/Applications** before opening it or registering AI clients. Avoid running from Downloads or a temporary folder; macOS App Translocation can change the path used by client registrations.
3. Open Laplace from Applications. This test build is unsigned and not notarized. If macOS blocks it, use **System Settings → Privacy & Security** to allow it only after you trust the chosen release and verify its checksum. Checksums do not replace code signing.
4. Add/import your own tools and catalog connectors in **On this device → Connections**, and register AI clients in **AI clients** after the app is in its stable location. These pages work without signing in. Sign in to open your Laplace workspace and hosted tools. If you later move the app, review and reinstall those client entries.

The packaged application includes Electron, Node/npm, uv, its helper and stdio bridge, and the native keychain binding. End users do not need this repository, a separate Node installation, or pnpm. Individual connectors may require an installed browser or download their own dependencies.

### Desktop MCP protocol and lifecycle

Desktop 0.1.9 uses MCP `2026-07-28` between the bundled bridge and the authenticated loopback `/mcp` endpoint. HTTP requests do not reserve transport sessions. The endpoint also supports stateless legacy HTTP requests; legacy clients needing tool-list notifications should use the stdio bridge, which supports both protocol generations. Each bridge owns one modern notification subscription and reconnects discovery and subscriptions after a helper restart with backoff from 250 ms to 5 seconds. A tool call is never replayed automatically.

Desktop owns connector processes and browser approvals across chat lifetimes. Tool calls, including queued calls, are limited to 32 per registered client and 128 overall. Subscriptions do not consume this capacity. Busy responses say the call was not started. A cancelled queued call is removed immediately; work that may have reached a connector retains the existing outcome-unknown handling. Local MCP diagnostics contain bounded protocol/count/cleanup information, without credentials, arguments, or results.

Existing connector configurations retain legacy negotiation. Set `"protocolVersion": "2026-07-28"` on a custom stdio or loopback HTTP configuration only when the connector requires the modern protocol. Import previews and setup tools preserve this optional field. Saved profiles need no migration. Desktop's hosted adapter keeps legacy negotiation and its current OAuth flow against the unchanged public gateway.

Upgrade the application bundle and plugin launcher together, then restart existing bridge processes once. Client registrations and provider/browser approvals remain in their existing storage. Rollback restores the complete previous application bundle; explicitly modern connector configurations require 0.1.9 or newer. Public update publication remains gated on the native packaging, update, and recovery evidence described in [Source updates](SOURCE-UPDATES.md).


**Windows x64 has been validated on a native Windows machine.** Local acceptance covers source-built runtimes, ZIP and Squirrel installer generation, silent install/uninstall, the installed application's Electron smoke checks, and packaged native keychain/process checks. Install a chosen release into its stable application location before registering AI clients. Validate the exact artifacts for each release; this local acceptance is not a published or signed Windows release. Cloudflare validates sources, while native Mac/Windows builds require those operating systems. This checkout does not publish a GitHub release, sign/notarize an application, deploy a backend, or publish update tags. Source-built installations can opt into the update flow below.

## Run from source

**Laplace Point** is available under **On this device → Device**, without sign-in. Enable it to use **Ctrl+L** or the tray's **Capture with Point**, drag a screen region, and add it to the current Codex draft. Selected crops remain local for seven days and can be cleared in Device settings. No chat message is submitted automatically.

Choose **Default agent** in Point settings: Codex current chat, Claude or ChatGPT desktop/browser, or Claude Code / Codex CLI. Codex current-chat mode verifies and attaches to the draft. Other desktop/browser modes open the selected agent and copy the image for you to paste. CLI mode opens a terminal and copies a local screenshot reference to paste into your running agent session; it does not start a CLI or execute commands. Existing snips keep the destination selected when captured. Changing the default affects the next snip. Browser/clipboard routes need Screen Recording on macOS; direct Codex control additionally needs Accessibility.

Native annotation delivery is enabled for the qualified Windows x64 Codex build `26.1023.6621.0`. Type in the native popup and press **Ctrl+Enter there** to add the comment to the draft; Point then attaches the original PNG. Other builds retain screenshot attachment fallback. See [Point architecture, validation status, and release qualification](../../docs/laplace-point.md).

Use Node 24 or newer and the repository's pnpm version. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @repo/desktop dev
```

On Windows, first install **Visual Studio Build Tools** with the **Desktop development with C++** workload, including the MSVC x64/x86 tools and Windows SDK. The build scripts discover Visual Studio through its installer and initialize the x64 compiler environment automatically, including during in-app source updates. An already configured **x64 Native Tools Command Prompt** or **Developer PowerShell** also works. Before downloading assets, runtime preparation uses `cl.exe` to compile and link a small Windows SDK probe without executing it, then builds the Windows process supervisor. Node, pnpm, and the compiler are source-build prerequisites; users of a complete packaged application do not need them. Use the full workspace install shown above so the web app's shared styles can resolve their dependencies.

The first launch downloads the pinned Node/npm/uv runtimes, builds the desktop app, and opens Electron. Subsequent launches reuse the runtimes. Restart `pnpm --filter @repo/desktop dev` after source changes; the command does not run a development watcher.

Desktop has two modes. **Laplace** (signed in and online) fills the window with Connect, exactly as in a browser: the web sidebar, workspace switcher, Home, Connections, Setup, Apps, and Settings. **On this device** is the bundled native renderer, with **Connections** (local servers, catalog, imports), **AI clients**, **Device**, and **Updates** tabs; **Credentials** is a dedicated sidebar destination. With a compatible signed-in Connect session, these pages replace only the main content: the existing sidebar, workspace switcher, and collapsed state stay in place, with **On this device** selected. Signed-out, offline, and older-server fallback screens retain the standalone sidebar, with **Back to Laplace** and **Sign out** when signed in or **Sign in** when signed out.

The web sidebar's **On this device** link (`/desktop/local`, shown only to the Desktop user agent) opens the native pages without contacting the server. Choose any normal sidebar destination to return to hosted content; switching workspaces also leaves the device view. In the standalone fallback, **Back to Laplace** returns to the same Connect page. **File → Laplace** (Cmd/Ctrl+1) and **File → On this device** (Cmd/Ctrl+2) switch modes, and the tray offers **On this device**. **Device** contains updates, runtime status, environment selection, and explicit installation linking/reconnection/unlinking; linking is separate from the workspace open in Laplace.

The persistent sidebar requires `localContentVersion: 1` from `/api/desktop/capabilities` and the Connect shell presentation bridge. Deploy Connect alongside the desktop update to enable it; older servers remain usable through the standalone local screen. The bridge accepts only validated content bounds and presentation changes from the primary Connect frame. Native device operations stay in the bundled renderer. Web menus and dialogs temporarily hide the native content view so they remain usable.

Desktop opens Connect at the last Connect page, or at `/` (the active workspace's Home). If Connect fails to load, the session ends (Connect shows its login page), or the server is too old, Desktop returns to On this device with a retry or sign-in prompt; local tools keep working.

Connect advertises `webShellVersion: 1` from `/api/desktop/capabilities`; Desktop shows Connect only when it is present. Connect keeps `embeddedShellVersion: 1` and its `X-Laplace-Desktop-Shell` chrome-less presentation for older Desktop builds; this build no longer sends that header. Deploy the compatible backend before distributing the Desktop build. Connect receives a write-only text clipboard preload, restricted by main-process checks to the primary Connect frame and origin. It receives no local-manager IPC or clipboard read access. OAuth popups receive no preload or privileged IPC.

Signing out (in Connect or On this device) blocks linked access and disconnects hosted client grants, clears the profile's web data, and returns to On this device; local-only connections remain usable. Switching environments uses separate cookies, connections, credentials, and clients.

| Profile           | Web app                           | Local state                                         |
| ----------------- | --------------------------------- | --------------------------------------------------- |
| Laplace           | `https://connect.withlaplace.com` | Hosted cookie partition and manager profile         |
| Local development | `http://127.0.0.1:3004`           | Separate cookies, servers, credentials, and clients |

Switching profiles stops the current profile's managed processes. Its saved configuration remains available when you switch back. Connect's permitted Builder destinations stay inside the desktop app.

## Test web sign-in and account linking

The local sidebar's **Sign in** opens the existing Laplace sign-in page in your default browser, using the methods enabled by that backend. After login, **Continue in Laplace Desktop** returns a short, one-use grant to a temporary loopback listener. Electron exchanges it using PKCE and installs the resulting HttpOnly session cookie in that profile. The callback never contains the browser session token.

This requires the new `/desktop/sign-in` page and `/api/desktop/*` / `/api/auth/desktop/*` routes from this checkout. A hosted server without those routes displays that desktop support is unavailable. Local tools, including catalog connectors, continue to work; hosted Laplace tools and linking require a supported signed-in session.

For hosted integration tests, start a compatible Laplace Connect development backend at http://127.0.0.1:3004. Start Desktop with `pnpm --filter @repo/desktop dev`, then choose **Local development** and sign in with a test account.

The browser and desktop share the source Laplace session; revoking that session also invalidates the desktop web session. Desktop sign-out disconnects hosted client grants and blocks linked tools. Servers explicitly kept local-only remain available.

Linking publishes connection identity, tool names, versions, health, and permission metadata. Configurations, command arguments, schemas, local tool inputs/results, environment values, and provider sessions stay local. Linked tools use the account's cloud permissions and block when authorization is unavailable. **Unlink** revokes the installation credential and retains the last tool restrictions locally; a later relink creates a new installation and preserves the prior account binding and restrictions. Review tool permissions when changing them locally or linking new tools.

## Add servers and AI clients

**On this device → Connections** lists this computer's connections and the catalog. Workspace provider accounts, other devices, and custom hosted MCPs are managed in Laplace's own Connections page.

In **Connections**, use **Add custom connection** for a stdio command or explicit loopback Streamable HTTP endpoint. The command is executed directly without a shell. Runtime aliases `node`, `npm`, `npx`, `uv`, and `uvx` use the bundled runtimes. Other executables must already be installed. HTTP servers are externally owned; stopping or removing their desktop connection does not terminate those servers.

**Import configuration** accepts supported JSON `mcpServers` files and Codex TOML `mcp_servers` tables. Review and select entries before importing. Secrets are stored in the system keychain, and the complete saved configuration is encrypted. There is no plaintext keychain fallback.

Each catalog **Connect** button has an agent selector. Choose an agent and Connect to open a connector-specific setup draft. Send it in the agent to continue; clients without prompt links use copy/paste. The prompt guides the agent through the existing local install, browser authentication, and verification flow. Select **Set up manually** in the same menu, then **Connect** to open the configuration form. No saved credentials are included in setup prompts.

The catalog is fully usable while signed out: install, authenticate, and verify run locally. Catalog connectors are published on npm as `@withlaplace/<connector>` packages and reviewed in the [Laplace MCP Library](https://github.com/acriver3/laplace-mcp-library). Install resolves the catalog's dist-tag (`latest`) to one exact version and installs it with Desktop's bundled npm into its own directory under `npm-packages`, with lifecycle scripts disabled, the user's npm configuration and credentials ignored, every dependency required to come from the npm registry with its lockfile integrity, and an `npm-shrinkwrap.json` required for Laplace packages. The connector runs the package's command with the catalog's arguments and environment, filled in from its settings. Installed connectors stay local-only unless this installation is linked. Availability depends on the operating system (a platform is offered when the package is published for it and has recorded acceptance, or the entry is a candidate) and each provider's browser/runtime requirements. Catalog actions can download dependencies and open provider login windows. LinkedIn's package is a launcher for a locked Python project: Desktop runs `uv sync --locked --no-dev --python 3.13` in the installed package with its bundled uv, and connectors receive that uv as `LAPLACE_UV`. Connector updates follow the dist-tag through the same install, switch and rollback path as choosing an npm version; tools added by a new version stay disabled until approved, and the update preferences, pins and deferral apply. Installations made from the earlier MCPB bundles move to their npm package, keeping their settings, sessions and connection ID, once Desktop is idle after starting and on each connector update check, while automatic connector updates are on and not postponed (a pinned connector stays as it is). Slack installs its npm package by default. The optional browser-extension adapter is exposed only when Desktop is launched with `LAPLACE_BROWSER_CONNECTION_ENABLED=true`; existing installations are not upgraded automatically. For that adapter: Enter the workspace URL, run Authenticate through MCP, then approve the Laplace Browser Connection extension in the existing signed-in Chrome or Edge tab. No Chromium download, dedicated profile, cookie import, or token export occurs. Verify uses channels_list; only channel/history/replies/search reads are exposed. See [extension setup and acceptance](browser-extension/README.md). Real Slack acceptance requires the user's extension approval and successful verification. Existing-install imports also work without sign-in. Tools kept local-only do not acquire a per-call online-login requirement; linked tools retain their cloud authorization checks.

Registered AI clients can also set up connectors directly over Desktop MCP. The `local_connectors_*` tools provide catalog discovery, installation, authentication, verification, custom configuration preview/add, job status, and cancellation. They reuse the Desktop installer and appear even with no installed connectors. Unrestricted clients receive setup tools automatically; restricted clients need explicit grants. Agent-installed connectors stay local-only, and setup never expands client tool permissions or publishes management tools through the hosted relay. Custom HTTP keeps the existing loopback-only rule; generic OAuth is not supported. Setup jobs survive MCP disconnects until Desktop restarts, and revoking the initiating client or setup permission cancels its running jobs. Provider sign-in/MFA/consent remains interactive. Installation alone is not proof of a working connection.

In **On this device → AI clients**:

1. Choose **Codex**, **Claude Code**, or **Claude Desktop**, then **Send setup**. Laplace adds a named registration automatically (or reuses the selected existing one), copies complete instructions, and opens an unsent draft using the same assistant destinations as the web app. Review and send the draft in your assistant.
2. For a terminal agent or an unavailable desktop app, choose **Copy setup instructions** and paste into your agent's chat. If clipboard access fails, expand **View setup instructions** to select the text yourself. No terminal commands, IDs, or configuration paths are required in the normal flow.
3. The agent receives only the bundled bridge invocation, never keychain credentials or existing client configuration. Instructions tell it to preserve existing entries, ask before replacing a conflicting Laplace entry, and verify the actual MCP connection by listing tools after reload/restart. A registration or opened draft is not proof of connection. Claude Code asks for a project when needed; Claude Desktop chats without filesystem access use **Advanced: manual setup** to preview/install locally.
4. **Advanced: manual setup** retains the original configuration preview, file selection, backups, and generic stdio configuration. Each registration has its own revocable local credential, kept out of prompts and client configuration files.
5. After signing in, optionally choose **Connect Laplace tools** for that registration. This uses the existing hosted MCP OAuth flow and stores a separate grant per client. Signing into the desktop web app does not automatically grant hosted tools to an AI client. Bitwarden access remains separately opt-in in Settings.

Registered assistants with Desktop management access can use `local_desktop_manage` to inspect sanitized account/device and authorization status, open a settings section, begin hosted consent for their own registration, disconnect their hosted tools, and start/stop/restart connectors. Connector lifecycle actions also require connector-management access. The existing `local_connectors` tools handle installation and configuration. The tool cannot approve consent, unlock a vault, edit access grants, read credentials, or manage another assistant's authorization. Opening Device or AI clients lets the user complete those steps. OAuth failures report a fixed stage and HTTP status without response bodies, tokens, or callback URLs.

Client configuration changes create a backup and preserve unrelated settings. Existing `laplace` and `laplace-local` entries stay unless you explicitly select them for replacement. Keep only the connections you intend to use to avoid duplicate tool catalogs or competing provider sessions. Revoking one client does not disconnect another. **Local tool access** lets you restrict each client to selected tools; server enablement and linked account permissions still apply.

The installed stdio bridge connects to the desktop helper's authenticated loopback endpoint. It can launch the registered desktop executable if needed. Local tool names are scoped to their server; downstream clients share the same upstream process and provider session. Tool calls are serialized per upstream, cancellable, bounded, and never replayed automatically after an uncertain outcome.

## Bitwarden credential access

**Credentials** in the sidebar contains Bitwarden setup, assistant access, Chrome readiness, Doppler source guidance, and recent requests. Broker approvals appear directly in the assistant’s MCP App, with Desktop fallback for older clients. **Unlock Bitwarden** in the card opens a focused local Desktop prompt and retains the same request. OAuth starts in the user’s existing Chrome profile without requiring unused vault credentials. Approved login steps and verification continue automatically; MFA and consent remain user-controlled. Laplace manages its own isolated Bitwarden CLI installation; agents never receive raw credentials in tool responses. Technical API/command configuration remains under Advanced settings. See [setup, supported operations, security boundaries, and hosted rollout](../../docs/bitwarden-credential-access.md).

## State and lifecycle

The default data directory is Electron's `userData` location for **Laplace**: normally `~/Library/Application Support/Laplace` on macOS and `%APPDATA%/Laplace` on Windows. Each profile lives under `profiles/hosted` or `profiles/local`. Cookie storage uses separate persistent Electron partitions. Keychain accounts are scoped by the absolute profile-root hash.

The Electron main process owns the window, the Connect view and its navigation boundary, browser handoff, and the trusted local renderer's IPC. Connect runs in a sandboxed view without Node access. Its narrow clipboard preload forwards text writes only; the main process validates the sender, frame, origin, payload type, and size. Native agent handoffs allow only the Codex, Claude, and Cursor draft/install routes used by Connect. A separate bundled Node helper owns encrypted state, MCP connections, process supervision, and the authenticated loopback listener. Each registered AI client connects through a small stdio bridge.

Closing a window hides it. Reopen it through the tray/menu-bar icon or app activation. **Stop Laplace Runtime** stops managed stdio process trees; externally owned HTTP servers always remain running. If the helper exits unexpectedly, restart Laplace; in-flight calls are not retried.

Desktop runs the background **Laplace Runtime** by default: it installs its bundled runtime into a stable per-user location, connects to it (or starts it), and offers Close Laplace Desktop, Stop/Start Laplace Runtime, Start at login, and Keep awake controls. Closing Desktop leaves connectors available to AI clients. See [Laplace Runtime](../../docs/laplace-runtime.md).

## Build and test

The existing **Cloudflare Workers Builds** connector validation path also runs desktop type checks, unit tests, and the source build. Those checks use synthetic fixtures and need no provider or system-keychain credentials. Run them locally after installing workspace dependencies:

```sh
pnpm --filter @repo/desktop check:source
```

This command strips inherited deployment/provider credentials and does not launch Electron, install connector runtimes, authenticate providers, or create distribution packages. Cloudflare's Linux x86_64 build image checks the source; it cannot validate macOS or Windows native behavior. No remote desktop native-build job is configured.

Run native checks on each target system: macOS Apple Silicon, macOS Intel, and Windows x64. Windows runtime preparation requires a Visual Studio C++ developer environment to build the process supervisor.

```sh
pnpm build
pnpm test
pnpm --filter @repo/desktop type-check

# Native Electron checks: prepare runtime assets first.
pnpm --filter @repo/desktop runtimes
pnpm --filter @repo/desktop test:electron
pnpm --filter @repo/desktop test:cookie
pnpm --filter @repo/desktop test:native

# Backend contracts and existing authentication regressions.
```

The source checks run without native runtime preparation on Linux and macOS. On Windows, prepare the runtime assets first because the unit fixtures also exercise the Windows process supervisor.

The Electron smoke check launches the built app against a synthetic loopback server, creates a temporary profile and isolated keychain accounts, and cleans them up afterward. It exercises the unauthenticated manager through trusted IPC, two actual stdio bridges with independently authenticated MCP sessions sharing one upstream PID, web-view isolation, hide/restore, and quit cleanup. It saves a screenshot to `.cache/smoke.png`. It requires a desktop session and an unlocked persistent system keychain. It never opens an actual AI client, changes user client files, or authenticates with a real provider. If keychain cleanup fails, it retains a nonsecret ownership journal and reports its path for an exact cleanup retry.

The native check additionally covers encrypted state across helper restarts, persistent client registrations, and managed process-tree cleanup after abrupt helper termination.

The cookie check uses synthetic cookies to verify that Electron `session.fetch` stores and sends a host-only Secure HttpOnly session, while the other profile stays unauthenticated. Backend tests exercise the actual Better Auth authorize/exchange handlers, including form submission, PKCE, expiry, source-session checks, and replay rejection. Provider OAuth/email delivery and real AI-client use remain manual acceptance checks.

The test harness uses `LAPLACE_DESKTOP_TEST_ROOT` to isolate Electron data and `LAPLACE_DESKTOP_TEST_ORIGIN` for an unpackaged-only `http://127.0.0.1:<port>` fixture origin. These are test controls, not supported production profile settings.

## Package a local build

Run on the target operating system and CPU architecture:

```sh
# Unpacked application
pnpm --filter @repo/desktop package

# Installable/test distribution artifacts
pnpm --filter @repo/desktop make
```

Artifacts are written under `apps/desktop/out`. macOS produces an application and ZIP. Windows produces an application, ZIP, and Squirrel installer. Runtime binaries and native keyring bindings are included. The application uses Electron 44 and the repository's pinned runtime versions.

Run the same Electron smoke check against an unpacked packaged executable to verify its bundled helper and runtime paths:

```sh
pnpm --filter @repo/desktop test:electron --packaged "/absolute/path/to/Laplace.app/Contents/MacOS/Laplace"
# On Windows, pass the absolute path to Laplace.exe instead.

# Verify the packaged Node runtime, keychain binding, bridge, and process cleanup.
pnpm --filter @repo/desktop test:native --packaged
```

Packaged smoke claims `127.0.0.1:3004` for its synthetic server and aborts if that port is already occupied. Stop only your own development server before running it. It writes `.cache/smoke-packaged.png` and uses temporary data rather than your installed app profile.

It also intercepts hosted HTTPS and stubs external browser opening to verify popup handoff: the hidden sandboxed popup has no preload or desktop bridge, hands the provider URL off once, and closes. The same test checks Send to agent reaches the native launcher and write-only clipboard API, while clipboard reads and invalid payloads remain blocked. Native launches and clipboard writes are stubbed. This test performs no real provider login.

These builds are unsigned and macOS builds are not notarized. Downloaded ZIPs do not update themselves. Source-built installations can enable the in-app source update flow below. Distribution signing, notarization, installed-platform acceptance, and backend deployment are separate release work. Linux packaging is not included in this version.

## Prepare GitHub Release assets locally

GitHub Releases hosts downloadable files; Cloudflare continues to run source validation. Preparing files does not create a release, upload an asset, trigger a job, or publish anything.

The desktop archive and hosted web deployment are separate deliverables. Release notes should state whether the desktop sign-in endpoints and desktop-only sidebar link are available on the selected backend. The native **Connections** menu and tray actions remain available independently of hosted navigation. Installation instructions should start with the local **Home**, **Connections**, **Setup**, and **Settings** screens. Connections and Setup provide the local runtime and assistant controls; Apps requires sign-in.

After native and packaged Electron smoke checks pass for an exact archive, record its SHA-256 and validation scope in a JSON manifest. Archive paths are relative to that manifest. For example:

```json
{
	"version": "0.1.0",
	"sourceRevision": "<40-character validated source commit>",
	"workingTreeChanges": false,
	"artifacts": [
		{
			"platform": "darwin-arm64",
			"file": "make/zip/darwin/arm64/Laplace-darwin-arm64-0.1.0.zip",
			"sha256": "<64-character SHA-256 recorded after validation>",
			"validation": {
				"packagedElectron": "passed",
				"nativeRuntime": "passed",
				"execution": "native",
				"notes": "Describe the tested machine and any remaining acceptance checks."
			}
		}
	]
}
```

Set `workingTreeChanges` accurately for local builds. For Intel checks performed on Apple Silicon, use `execution: "rosetta"` and record that physical Intel acceptance is still separate. Include only platforms whose checks have passed for the exact selected archive, including native Windows checks for a Windows artifact. The declared test results are the operator's record, not tests performed by the preparation command.

```sh
pnpm --filter @repo/desktop release:prepare --manifest /absolute/path/to/validated.json --out /absolute/path/to/new-release-folder
# Optionally add --repo OWNER/REPOSITORY to link your chosen GitHub Releases page.
```

The command rejects stale archive hashes, missing standalone runtime/helper/keychain assets, missing passed checks, duplicate platforms, and an existing output directory. It copies the selected ZIPs and writes `SHA256SUMS`, `INSTALL.md`, and `RELEASE-MANIFEST.json`. It verifies the copied bytes again and records native versus Rosetta scope. The resulting folder can be reviewed before a separately authorized GitHub Release upload. Rebuild and repeat validation after application changes; an earlier archive's recorded checks do not validate a new build.

## Portable connectors

The [portable connector workflow](../../docs/portable-connectors.md) adds independent
MCPB instances, bulk/import operations, per-connection visibility, remote execution,
and Make local copy. New instances are local by default and visible after linking.
Provider credentials and authentication profiles never copy between devices.

Open MCPB bundles or drop them onto **Install connectors**. Each item has its own
configuration, sign-in, verification, cancellation, retry, and repair actions.
Agent clients use `local_connectors_manage` and poll `local_connectors_status`;
reusing an idempotency key returns the existing operation. Normal client setup
also writes the plugin's nonsecret bridge descriptor and verifies MCP discovery.

Linked browser inventory can target an online desktop. Authorize an AI client's
**desktop management** separately to grant `desktop:manage`. Existing OAuth grants
retain their scopes. Complete authentication on the selected desktop. Offline
sources can be copied after their bundle and safe snapshot have synced; offline
targets reject management requests without queuing them.
