# Laplace plugin

Connect supported desktop AI clients to hosted Laplace services and this computer's Laplace Desktop tools.

## Connection

- Hosted MCP connection `laplace`: `https://connect.withlaplace.com/mcp`, with OAuth (Laplace login and organization consent).
- Local MCP connection `laplace-local`: packaged stdio launcher for the installed Laplace Desktop bridge. Local-only tools require no Laplace login. Desktop's per-client credential stays in the OS keychain; provider login may still be required.
- Publisher: Laplace
- Display name: `Laplace`; MCP connection names: `laplace` and `laplace-local`
- Branding: two overlapping squares, with the right square rising, matching the Connect application

The package contains a portable `plugin.json` and `mcp.json`, a Codex compatibility manifest and MCP configuration, a workflow skill, and PNG/SVG icons. There are no credentials in the package.

## Install and verify

1. Open the saved Laplace plugin from the link returned by Plugin Creator.
2. Install the plugin and use the host's Connect flow for the declared MCP server.
3. Sign in to Laplace and select the intended organization.
4. Select the connection in a new chat and ask “Which services do I have connected in Laplace?”
5. Test action search and guide retrieval, then a read operation on a connected test account. Test writes only against disposable sample data with an explicit request.

The package declares the existing remote MCP server directly, plus a local stdio launcher. OAuth credentials are managed by the host and Laplace, never embedded in the package. Local stdio requires a host that supports local plugin processes; installing the package in a web or mobile host does not give it access to your computer.

## Set up the local connection

Install Laplace Desktop and make Node.js available as `node` to the AI client. The launcher has no npm dependencies; Desktop supplies its own bridge runtime. Run setup and the plugin on the same operating system as Desktop (a WSL process cannot use a Windows keychain registration).

1. In Desktop, open **On this device → AI clients** and create a dedicated registration for this plugin. In **Advanced: manual setup**, obtain its generic stdio configuration. Leave **Connect Laplace tools** disconnected for this registration, since this plugin's separate `laplace` connection already supplies hosted tools.
2. Save only the registration entry's `command` and `args` object to a local `registration.json` file. Use the exact absolute runtime/bridge paths, `--root`, and `--client-id` supplied by Desktop. Do not include the surrounding `mcpServers` object or any credentials.
3. From this plugin's directory, run:

   ```sh
   node scripts/local-bridge.mjs --configure /absolute/path/to/registration.json
   ```

4. Reload the plugin's MCP connections. List tools from `laplace-local` and invoke a harmless read tool from an installed local connector. Hosted OAuth is independent; local-only tools can be used while signed out.

Setup saves the nonsecret registration at `~/.laplace-desktop/plugin-bridge.json`. Set `LAPLACE_PLUGIN_BRIDGE_CONFIG` to an absolute path in the host's environment to use a different file. Reconfigure after moving Desktop or replacing/revoking the client registration. The launcher delegates port discovery, keychain access, process startup and MCP handling to Desktop's existing bridge. It does not create an anonymous local HTTP endpoint. Cloud-linked tools continue to enforce cloud authorization.

Avoid separately installing the same Desktop registration as another MCP connection in this AI client, which would duplicate its tools. Missing local setup reports an actionable error on the local connection; the hosted configuration is unchanged. Whether a host lets users connect each server independently must be verified in that host.

Run launcher and configuration checks with `node --test plugins/laplace/scripts/local-bridge.test.mjs` from the repository root. These checks use a synthetic child process; actual host loading, Desktop keychain access and provider calls require installation acceptance.

The package retains `laplace` as its identity and workflow skill, with `Laplace` as its display name. Hosted authorization and local bridge setup are independent.

The workflow uses `list_apps`, `list_connections`, `search_actions`, `get_action_guide`, and `execute_action`, as defined in the Laplace server source. App building and browser connections are paused by the current product policy. Saving the plugin is separate from authenticating and verifying live tools.

## Installing Desktop connectors through an agent

The registered `laplace-local` MCP connection exposes `local_connectors_list`, `local_connectors_install`, `local_connectors_authenticate`, `local_connectors_verify`, `local_connectors_preview_custom`, `local_connectors_add_custom`, `local_connectors_status`, and `local_connectors_cancel`, even before a provider connector is installed. These tools require an updated Desktop installation. Clients with unrestricted local access receive them automatically; restricted clients need the corresponding tools enabled in Desktop's client permissions.

List the catalog and its required configuration fields, install the selected connector, and poll its job using `local_connectors_status`. Installation is separate from authentication: use Authenticate to open the existing provider sign-in flow, let the user complete sign-in/MFA/consent, and check that verification succeeds. Slack requires its workspace HTTPS URL. Do not request credentials in chat or claim that a queued job is complete. Jobs survive MCP reconnects during the same Desktop helper run; after Desktop restarts, inspect installed connector state before retrying. Revoking the initiating client or its setup tool cancels its running setup jobs.

For custom servers, preview then add the existing Desktop configuration (`id`, `name`, `transport`, and `command`/`args`/`env` for stdio or `url`/`headers` for HTTP). HTTP retains Desktop's loopback-only restriction. Enabled custom servers start immediately; a saved configuration can still fail startup. There is no generic OAuth flow. Existing IDs are never overwritten, newly installed connectors stay local, and installation does not grant restricted clients permission to call their tools. Credentials are stored through existing Desktop configuration handling and are not returned in setup results. These management tools are not published through the hosted connector relay.

## Public distribution

This package is intended for a private plugin. A public directory submission requires separate publisher, domain, privacy, support, and reviewer materials through the Plugin Creator submission workflow. Saving this package does not submit a public listing.

## Maintenance

Keep the portable and compatibility manifests' identity, presentation, and endpoint consistent. The single source is `packages/ui/brand/logo.svg`. Run `pnpm brand:generate` from the repository root to regenerate this package’s SVG/PNG assets and every application’s artwork. See `packages/ui/brand/README.md` for the full update workflow.

Official documentation:

- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/submission

## Adding hosted connections

Use `list_accounts` to select an account, then `get_connection_setup` for its provider service (or `custom_mcp`). Owners/admins can call `add_connection` with an `idempotencyKey` and optional credential `values`. Omitting values returns a user setup link; OAuth always needs user consent. Never approve consent for the user or put credentials in prompts, logs, links, or application source. Poll `get_connection_request` and report success only for `connected`; `processing` or `uncertain` requires checking the same request before another addition. A verified matching account refreshes its existing connection, preserving its ID and permissions. Different accounts remain separate. These tools require the server's connection setup feature to be enabled.
