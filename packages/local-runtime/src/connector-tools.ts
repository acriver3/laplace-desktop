import { randomUUID } from "node:crypto";

import type { Tool } from "@modelcontextprotocol/server";
import { browserEnabled } from "@repo/local-mcp-core/browser-catalog";
import { serverConfig } from "@repo/local-mcp-core/config";
import {
	browserChatApprovalSchemas,
	browserChatApprovalDescriptions,
} from "@repo/project-protocol/mcp/local-tools";
import { localManagementRequest } from "@repo/project-protocol/portable-connectors";
import { z } from "zod";

import { browserAuthorizer, type BrowserApprovals } from "./browser-approvals";
import type { NpmConnectors } from "./connector-versions";
import type { CatalogInstaller, CatalogJob } from "./catalog";
import { normalizeManualConfiguration, previewManualConfiguration } from "./imports";
import type { DesktopManager } from "./manager";
import { npmConnectorsEnabled, packageName } from "./npm-source";
import type { PortableConnectors } from "./portable";
import { BROWSER_APPROVAL_URI } from "./shared/browser-approval";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const empty = z.object({}).strict();
const custom = z.object({ config: serverConfig }).strict();
const definitions = {
	local_connectors_browser_prompt: [
		browserChatApprovalSchemas.local_connectors_browser_prompt,
		browserChatApprovalDescriptions.local_connectors_browser_prompt,
	],
	local_connectors_browser_confirm: [
		browserChatApprovalSchemas.local_connectors_browser_confirm,
		browserChatApprovalDescriptions.local_connectors_browser_confirm,
	],
	local_connectors_migrate: [
		z
			.object({
				id,
				catalogId: id,
				configuration: z.record(z.string(), z.string()).default({}),
				confirm: z.literal(true),
			})
			.strict(),
		"Explicitly migrate a chosen existing or imported connection to an activated tethered catalog connector. Preserve its ID, name and permissions. Returns an approval job; the user must approve the account and profile in local_connectors_browser_show. Previous configuration and sessions are retained.",
	],
	local_connectors_migration_rollback: [
		z.object({ id, confirm: z.literal(true) }).strict(),
		"Explicitly restore the previous configuration from a browser migration recovery record. Revokes the new browser approval and preserves all session files. Never call this as an automatic fallback.",
	],
	local_connectors_browser_show: [
		z.object({ requestId: z.string().uuid() }).strict(),
		"Show the browser connection approval card for an authentication job. The user approves the detected account in the card; never approve on their behalf.",
	],
	local_connectors_browser_review: [
		z.object({ requestId: z.string().uuid() }).strict(),
		"Refresh this user's browser approval card.",
	],
	local_connectors_browser_approve: [
		z.object({ requestId: z.string().uuid(), capability: z.string().min(40).max(100) }).strict(),
		"Approve the reviewed browser identity only when the user clicks Approve connection.",
	],
	local_connectors_browser_cancel: [
		z.object({ requestId: z.string().uuid() }).strict(),
		"Cancel this browser connection and revoke remembered consent.",
	],
	local_connectors_browser_focus: [
		z.object({ requestId: z.string().uuid(), profileId: z.string().uuid() }).strict(),
		"Bring the service tab forward only when the user selects Finish signing in.",
	],
	local_connectors_browser_desktop: [
		z.object({ requestId: z.string().uuid() }).strict(),
		"Open this specific approval in Laplace Desktop when the client cannot display MCP Apps.",
	],
	local_connectors_manage: [
		localManagementRequest,
		"Install a bundle file or catalog connector, install a batch, configure, authenticate, verify, repair, remove, or set visibility and remote access. For durable retries of any action use {idempotencyKey, command}; poll local_connectors_status with the returned operationId as jobId. Provider credentials must be entered on Desktop, never in chat.",
	],
	local_connectors_list: [
		empty,
		"List Desktop catalog connectors, setup fields, platform availability, installed summaries, and visible connectors on your other devices. Use local_connectors_manage with action=copy, sourceId and a new idempotencyKey to make an independent local copy with fresh sign-in.",
	],
	local_connectors_install: [
		z
			.object({
				catalogId: id,
				configuration: z.record(z.string(), z.string()).default({}),
				idempotencyKey: z.string().min(1).max(200).optional(),
			})
			.strict(),
		"Install a Desktop catalog connector. Returns a job; poll local_connectors_status before retrying. Installation does not mean authenticated.",
	],
	local_connectors_authenticate: [
		z.object({ id }).strict(),
		"Start connector sign-in and verification. For browserApproval call local_connectors_browser_show in MCP Apps hosts. Without MCP Apps, use local_connectors_browser_prompt, show the account/profile/scopes and wait for the user's explicit approve reply before local_connectors_browser_confirm. Give signInUrl when signed out. Desktop approval is an optional fallback.",
	],
	local_connectors_verify: [
		z.object({ id }).strict(),
		"Verify a catalog connector using its existing authenticated read checks. Poll the returned job.",
	],
	local_connectors_preview_custom: [
		custom,
		"Validate and preview a custom Desktop server without execution. Use Desktop configuration with id, name, transport and command/args/env or loopback HTTP url/headers. Never request secrets in chat.",
	],
	local_connectors_add_custom: [
		custom,
		"Add a custom Desktop server without replacing an existing ID. Enabled configurations start immediately. Uses existing stdio or loopback HTTP configuration; no generic OAuth. Never request secrets in chat.",
	],
	local_connectors_status: [
		z.object({ id: id.optional(), jobId: z.string().uuid().optional() }).strict(),
		"Inspect installed connector state and setup jobs, including after reconnecting. Supply id or jobId to narrow results. Operation receipts survive helper restarts; interrupted actions are not replayed.",
	],
	local_connectors_cancel: [
		z.object({ jobId: z.string().uuid() }).strict(),
		"Cancel a Desktop catalog setup job. Poll status until cancellation completes.",
	],
	local_connectors_add_npm: [
		z
			.object({
				id,
				name: z.string().min(1).max(120),
				package: packageName,
				version: z.string().min(1).max(100).default("latest"),
				bin: z.string().min(1).max(214).optional(),
				args: z.array(z.string().max(8000)).max(50).optional(),
				env: z
					.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32000))
					.optional(),
			})
			.strict(),
		"Add a connector published on npm. Laplace catalog connectors (the @withlaplace packages listed by local_connectors_list) install best with local_connectors_install, which fills their settings and sign-in checks; other npm MCP servers work here. Desktop installs the exact version (a dist-tag such as latest is resolved now) with lifecycle scripts disabled and runs it under the Laplace Runtime. Does not replace an existing ID. env holds non-secret settings only; never pass passwords or tokens in args or env. Use local_connectors_list to see each connector's npm package and version.",
	],
	local_connectors_versions: [
		z.object({ id }).strict(),
		"List published npm versions and dist-tags for an npm-installed connector, with its current version.",
	],
	local_connectors_set_version: [
		z.object({ id, version: z.string().min(1).max(100) }).strict(),
		"Switch an npm-installed connector to an exact published version or dist-tag (upgrade or downgrade). The previous version is restored if the new one fails to start. Tools introduced by the new version stay disabled until the user approves them in Desktop.",
	],
} as const;
const npmTools: string[] = [
	"local_connectors_add_npm",
	"local_connectors_versions",
	"local_connectors_set_version",
];
export type ConnectorToolName = keyof typeof definitions;
export const connectorManagementTools: Tool[] = Object.entries(definitions)
	.filter(
		([name]) =>
			(browserEnabled() ||
				!["local_connectors_migrate", "local_connectors_migration_rollback"].includes(name)) &&
			(npmConnectorsEnabled() || !npmTools.includes(name)),
	)
	.map(([name, [schema, description]]) => ({
		name,
		...(name.startsWith("local_connectors_browser_")
			? {
					_meta: {
						ui: {
							...(name.endsWith("_show") ? { resourceUri: BROWSER_APPROVAL_URI } : {}),
							visibility: [
								name.endsWith("_show") ||
								name.endsWith("_desktop") ||
								name in browserChatApprovalSchemas
									? "model"
									: "app",
							],
						},
					},
				}
			: {}),
		title: `Desktop connectors: ${name.slice("local_connectors_".length).replaceAll("_", " ")}`,
		description,
		inputSchema: {
			...z.toJSONSchema(schema, { io: "input" }),
			type: "object",
		} as Tool["inputSchema"],
		annotations: {
			readOnlyHint: [
				"local_connectors_browser_show",
				"local_connectors_browser_review",
				"local_connectors_browser_prompt",
				"local_connectors_list",
				"local_connectors_status",
				"local_connectors_preview_custom",
				"local_connectors_versions",
			].includes(name),
			destructiveHint: name === "local_connectors_manage",
			openWorldHint: true,
		},
	}));
export const isConnectorManagementTool = (name: string): name is ConnectorToolName =>
	Object.hasOwn(definitions, name);

/** Only fixed job fields/messages cross MCP; provider errors can contain credentials. */
function jobSummary(job: CatalogJob) {
	const state =
		job.status === "completed"
			? job.kind === "install"
				? "authentication_required"
				: "verified"
			: job.status;
	return {
		id: job.id,
		catalogId: job.catalogId,
		serverId: job.serverId,
		kind: job.kind,
		status: job.status,
		state,
		stage: job.stage,
		progress: job.progress,
		...(job.status === "running" && job.browserApproval
			? {
					browserApproval: {
						...job.browserApproval,
						renderTool: "local_connectors_browser_show",
						fallbackTool: "local_connectors_browser_prompt",
					},
				}
			: {}),
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		...(job.status === "failed"
			? {
					error: "Setup failed. Review the connector's diagnostics in Desktop before retrying.",
				}
			: {}),
	};
}

export class ConnectorManagement {
	private owners = new Map<string, { clientId: string; tool: ConnectorToolName }>();
	constructor(
		private manager: DesktopManager,
		private installer: Pick<
			CatalogInstaller,
			"list" | "jobs" | "install" | "authenticate" | "verify" | "cancel"
		> &
			Partial<Pick<CatalogInstaller, "migrateImported" | "rollbackMigration">>,
		private portable?: PortableConnectors,
		readonly browserApprovals?: BrowserApprovals,
		private openBrowserApproval?: (requestId: string) => void,
		private npm?: NpmConnectors,
	) {}
	canCall(clientId: string, tool: string) {
		return tool.startsWith("local_connectors_browser_")
			? this.manager.clientToolAllowed(clientId, "local_connectors_authenticate") ||
					this.manager.clientToolAllowed(clientId, "local_connectors_manage") ||
					this.manager.clientToolAllowed(clientId, "local_connectors_migrate")
			: npmTools.includes(tool)
				? this.manager.clientToolAllowed(clientId, tool) ||
					this.manager.clientToolAllowed(clientId, "local_connectors_manage")
				: this.manager.clientToolAllowed(clientId, tool);
	}
	private authorize(clientId: string, tool: string) {
		this.manager.client(clientId);
		if (!this.canCall(clientId, tool))
			throw new Error("Connector setup tool disabled for this client.");
	}
	permissionsChanged() {
		for (const job of this.installer.jobs()) {
			const owner = this.owners.get(job.id);
			if (!owner || job.status !== "running") continue;
			try {
				this.authorize(owner.clientId, owner.tool);
			} catch {
				this.installer.cancel(job.id);
			}
		}
	}
	private servers() {
		return this.manager
			.listServers()
			.map(({ id, name, transport, enabled, status, linkMode, access }) => {
				const config = this.manager.getServerConfig(id);
				const npm = config.transport === "stdio" ? config.npm : undefined;
				return {
					id,
					name,
					transport,
					enabled,
					status,
					linkMode,
					access,
					...(npm ? { npm: { package: npm.package, version: npm.version } } : {}),
				};
			});
	}
	async call(clientId: string, name: string, input: Record<string, unknown>) {
		this.authorize(clientId, name);
		if (!isConnectorManagementTool(name)) throw new Error("Unknown connector management tool.");
		const args = definitions[name][0].parse(input);
		if (name.startsWith("local_connectors_browser_")) {
			if (!this.browserApprovals) throw Error("Update Desktop to approve browser connections.");
			const requestId = (args as { requestId: string }).requestId;
			this.browserApprovals.view(requestId, clientId);
			if (name.endsWith("_prompt")) {
				const result = this.browserApprovals.reviewChat(
					requestId,
					clientId,
					(args as { candidateId?: string }).candidateId,
				);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					structuredContent: result,
				};
			}
			if (name.endsWith("_confirm")) {
				const value = args as { reviewId: string; confirmed: true };
				const view = await this.browserApprovals.confirmChat(
					requestId,
					clientId,
					value.reviewId,
					value.confirmed,
				);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(view) }],
					structuredContent: view,
				};
			}
			if (name.endsWith("_approve"))
				await this.browserApprovals.approve(
					requestId,
					clientId,
					(args as { capability: string }).capability,
				);
			if (name.endsWith("_cancel")) await this.browserApprovals.cancel(requestId, clientId);
			if (name.endsWith("_focus"))
				await this.browserApprovals.focus(
					requestId,
					clientId,
					(args as { profileId: string }).profileId,
				);
			if (name.endsWith("_desktop")) this.openBrowserApproval?.(requestId);
			const { view, capabilities } = this.browserApprovals.review(requestId, clientId);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(view) }],
				structuredContent: view,
				_meta: { browserApprovalCapabilities: capabilities },
			};
		}
		const authorize = browserAuthorizer(() => this.authorize(clientId, name), clientId, name);
		let result: unknown;
		if (name === "local_connectors_migrate" || name === "local_connectors_migration_rollback") {
			if (!browserEnabled()) throw Error("Tethered browser migration is not activated.");
			if (!this.installer.migrateImported || !this.installer.rollbackMigration)
				throw Error("Desktop update required for browser migration.");
			const job =
				name === "local_connectors_migrate"
					? await this.installer.migrateImported(
							args as {
								id: string;
								catalogId: string;
								configuration: Record<string, string>;
								confirm: true;
							},
							authorize,
						)
					: await this.installer.rollbackMigration((args as { id: string }).id, authorize);
			this.owners.set(job.id, { clientId, tool: name });
			this.permissionsChanged();
			result = jobSummary(job);
		} else if (npmTools.includes(name)) {
			if (!this.npm || !npmConnectorsEnabled())
				throw new Error("npm connectors are not enabled on this computer.");
			if (name === "local_connectors_add_npm") {
				const value = args as z.infer<(typeof definitions.local_connectors_add_npm)[0]>;
				if (this.servers().some((s) => s.id === value.id))
					throw new Error("Connector ID already exists. Inspect its status; it was not replaced.");
				result = await this.npm.add(value, authorize);
			} else if (name === "local_connectors_versions")
				result = await this.npm.versions((args as { id: string }).id);
			else {
				const value = args as { id: string; version: string };
				result = await this.npm.setVersion(value.id, value.version, authorize);
			}
		} else if (name === "local_connectors_manage") {
			if (!this.portable) throw new Error("Update Desktop to manage portable connectors");
			result = await this.portable.manage(args, authorize);
		} else if (name === "local_connectors_install" && this.portable) {
			result = await this.portable.install(
				{ ...args, idempotencyKey: input.idempotencyKey ?? randomUUID() },
				authorize,
			);
		} else if (
			this.portable &&
			["local_connectors_authenticate", "local_connectors_verify"].includes(name)
		) {
			result = await this.portable.manage(
				{
					action: name === "local_connectors_authenticate" ? "authenticate" : "verify",
					id: (args as { id: string }).id,
				},
				authorize,
			);
			if (result && typeof result === "object" && "id" in result && typeof result.id === "string")
				this.owners.set(result.id, { clientId, tool: name });
			this.permissionsChanged();
		} else if (name === "local_connectors_list") {
			result = {
				catalog: await this.installer.list(),
				installed: this.servers(),
				devices: this.portable ? await this.portable.devices().catch(() => []) : [],
			};
		} else if (name === "local_connectors_status") {
			const { id, jobId } = args as z.infer<(typeof definitions.local_connectors_status)[0]>;
			const operations = this.portable
				? (await this.portable.status()).filter(
						(o) => (!id || o.connectorId === id) && (!jobId || o.id === jobId),
					)
				: [];
			const jobs = this.installer
				.jobs()
				.filter((job) => (!id || job.serverId === id) && (!jobId || job.id === jobId));
			const management =
				this.portable && jobId ? await this.portable.remoteStatus(jobId) : undefined;
			if (
				jobId &&
				!jobs.length &&
				!operations.length &&
				(!management || ("status" in management && management.status === "unavailable"))
			)
				throw new Error(
					"Unknown setup operation. Inspect the connector before starting another request.",
				);
			result = {
				management,
				operations,
				installed: this.servers().filter((s) => !id || s.id === id),
				jobs: jobs.map(jobSummary),
			};
		} else if (name === "local_connectors_cancel") {
			const jobId = (args as { jobId: string }).jobId;
			result =
				this.portable && (await this.portable.status(jobId)).length
					? await this.portable.cancel(jobId)
					: this.installer.cancel(jobId);
		} else if (
			name === "local_connectors_preview_custom" ||
			name === "local_connectors_add_custom"
		) {
			const { config } = args as z.infer<typeof custom>;
			const normalized = normalizeManualConfiguration(config);
			if (name === "local_connectors_preview_custom") {
				result = await previewManualConfiguration(normalized, this.manager);
			} else {
				// Do not mistake a pre-existing attachment for a partially saved new one.
				if (this.servers().some((s) => s.id === normalized.id))
					throw new Error("Connector ID already exists. Inspect its status; it was not replaced.");
				let saved = false;
				try {
					await this.manager.addServers([normalized], false, {
						localOnly: true,
						authorize: authorize,
						onSaved: () => {
							saved = true;
						},
					});
				} catch {
					if (!saved)
						throw new Error("Connector was not added. Check configuration and client permissions.");
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									saved: true,
									startupSucceeded: false,
									id: normalized.id,
									error:
										"Configuration saved but startup failed. Inspect Desktop diagnostics before retrying.",
								}),
							},
						],
					};
				}
				result = {
					saved: true,
					startupSucceeded: normalized.enabled
						? this.servers().find((s) => s.id === normalized.id)?.status === "online"
						: null,
					connector: this.servers().find((s) => s.id === normalized.id),
				};
			}
		} else {
			const job =
				name === "local_connectors_install"
					? await this.installer.install(
							args as { catalogId: string; configuration: Record<string, string> },
							{ localOnly: true, authorize: authorize },
						)
					: name === "local_connectors_authenticate"
						? await this.installer.authenticate((args as { id: string }).id, authorize)
						: await this.installer.verify((args as { id: string }).id, () =>
								this.authorize(clientId, name),
							);
			this.owners.set(job.id, { clientId, tool: name });
			// An async installer preflight may have overlapped a revocation.
			this.permissionsChanged();
			result = jobSummary(this.installer.jobs().find((current) => current.id === job.id) ?? job);
		}
		this.authorize(clientId, name);
		return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
	}
}
