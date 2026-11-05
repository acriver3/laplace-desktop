import { createHash, randomBytes, randomUUID } from "node:crypto";

import { browserProviders } from "@repo/browser-runtime/browser-approval";
import { LocalApi, LocalApiError } from "@repo/local-mcp-core/api";
import {
	verifyBrowserConfiguration,
	browserSetupTools,
} from "@repo/local-mcp-core/browser-catalog";
import {
	BrowserMigrationStage,
	type BrowserMigration,
} from "@repo/local-mcp-core/browser-migration";
import { serverConfig, type ServerConfig } from "@repo/local-mcp-core/config";
import { EncryptedStore } from "@repo/local-mcp-core/encrypted-store";
import { LocalStore, systemEntry, type EntryFactory } from "@repo/local-mcp-core/store";
import { Supervisor } from "@repo/local-mcp-core/supervisor";
import {
	configurationSchema,
	canonicalJson,
	connectorOriginSchema,
	scopedToolName,
	type Configuration,
	type Invocation,
	type Publication,
} from "@repo/project-protocol/local-mcp";
import { localConnectorTool } from "@repo/project-protocol/mcp/local-tools";
import {
	connectorAccess,
	defaultConnectorAccess,
	type ConnectorAccess,
	type PortableSnapshot,
} from "@repo/project-protocol/portable-connectors";
import { z } from "zod";

import type { ClientSnapshot, DesktopSnapshot, ServerSnapshot } from "./shared/helper-contracts";
import { slackSetupNames } from "./shared/slack-browser";
import { ycBrowserIdentity, ycSetupNames } from "./shared/yc-browser";
import { connectorManagementTools } from "./connector-tools";
import { desktopManagementTool } from "./desktop-tools";
import { configurationSummary } from "./imports";
import { assertLegacyProcessesStopped } from "./legacy-processes";
import { allBundleCatalog } from "./library-catalog";
import { slackBrowserIdentity } from "./slack-browser-config";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const credentialDigest = (value: string) => createHash("sha256").update(value).digest("base64url");
const pairing = z
	.object({
		origin: connectorOriginSchema,
		installationId: z.string().uuid(),
		accountId: z.string().min(1),
	})
	.strict();
const desktopState = z
	.object({
		version: z.literal(1).default(1),
		mode: z.enum(["local-only", "linked"]).default("local-only"),
		stayLocalOnly: z.boolean().default(false),
		linking: z.boolean().default(false),
		blocked: z.boolean().default(false),
		origin: connectorOriginSchema,
		pairing: pairing.optional(),
		lastPermissions: configurationSchema.optional(),
		localOnly: z.record(z.string(), z.boolean()).default({}),
		access: z.record(z.string(), connectorAccess).default({}),
		migrationPending: z.record(z.string(), z.boolean()).default({}),
		localLimits: z
			.record(z.string(), z.object({ enabled: z.boolean(), tools: z.array(z.string()) }).strict())
			.default({}),
		clients: z
			.array(
				z
					.object({
						id: z.string().uuid(),
						name: z.string().min(1).max(80),
						enabled: z.boolean(),
						tokenHash: z.string(),
						createdAt: z.string(),
						allowedLocalTools: z.array(z.string()).max(15000).optional(),
					})
					.strict(),
			)
			.max(50)
			.default([]),
		revocations: z
			.array(z.object({ origin: connectorOriginSchema, key: z.string() }).strict())
			.default([]),
	})
	.strict();
type DesktopState = z.infer<typeof desktopState>;

export class DesktopManager {
	readonly runId = randomUUID();
	readonly supervisor: Supervisor;
	readonly store: LocalStore;
	readonly entries: EntryFactory;
	private policy: EncryptedStore<DesktopState>;
	private state: DesktopState;
	private configurations: ServerConfig[] = [];
	private cloud?: Configuration;
	private error?: string;
	private syncing?: Promise<void>;
	private mutations: Promise<unknown> = Promise.resolve();
	private epoch = 0;
	private invocations = new WeakMap<Invocation, number>();
	private setupInvocations = new WeakSet<Invocation>();
	private remoteInvocations = new WeakSet<Invocation>();
	private invocationClients = new WeakMap<Invocation, string>();
	private stopped = false;
	private explicitlyBlocked = false;
	private blockGeneration = 0;
	private listeners = new Set<() => void>();
	private apiFactory: (origin: string, token: string) => Pick<LocalApi, "post">;
	endpoint?: string;
	jobs: () => unknown[] = () => [];
	portableSnapshots: () => Array<{ id: string; snapshot: PortableSnapshot }> = () => [];
	credentialRequests: () => number = () => 0;
	mcpDiagnostics: () => DesktopSnapshot["mcp"] = () => undefined;
	hostedStatus: (id: string) => Pick<ClientSnapshot, "hosted" | "error"> = () => ({
		hosted: "disconnected",
	});
	private browserStages = new Map<string, BrowserMigrationStage>();
	constructor(
		readonly root: string,
		readonly resources: string,
		origin: string,
		options: {
			entries?: EntryFactory;
			apiFactory?: (origin: string, token: string) => Pick<LocalApi, "post">;
		} = {},
	) {
		this.state = desktopState.parse({ origin });
		this.entries = options.entries ?? ((name) => systemEntry(root, name));
		this.store = new LocalStore(root, this.entries);
		this.policy = new EncryptedStore(
			root,
			"desktop",
			desktopState,
			() => desktopState.parse({ origin }),
			this.entries,
		);
		this.apiFactory = options.apiFactory ?? ((base, token) => new LocalApi(base, token));
		this.supervisor = new Supervisor(
			root,
			resources,
			() => this.changed(),
			(publication) => this.publish(publication),
			(invocation) => this.authorize(invocation),
		);
	}
	onChanged(listener: () => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	changed() {
		for (const listener of this.listeners) listener();
	}
	async initialize(waitForConnections = true) {
		this.state = await this.policy.read();
		this.explicitlyBlocked = this.state.blocked;
		await this.reload();
		// Freeze legacy privacy before applying the new defaults to future installations.
		await this.save((state) => {
			for (const config of this.configurations)
				state.access[config.id] ??= {
					visible: state.mode === "linked" && !state.localOnly[config.id],
					remoteEnabled: false,
				};
		});
		const startup = (async () => {
			await Promise.allSettled(
				this.configurations
					.filter((c) => c.enabled)
					.map(async (c) => {
						if (this.state.migrationPending[c.id]) await assertLegacyProcessesStopped(c);
						await this.supervisor.start(c.id);
					}),
			);
			await this.refresh().catch(() => {});
		})();
		this.changed();
		if (waitForConnections) await startup;
	}
	private async save(work: (state: DesktopState) => void | Promise<void>) {
		this.state = await this.policy.mutate(work);
	}
	private async reload() {
		this.configurations = (await this.store.read()).servers.map((config) => {
			const setup =
				config.identity === slackBrowserIdentity
					? slackSetupNames
					: config.identity === ycBrowserIdentity
						? ycSetupNames
						: [];
			return config.enabledTools && setup.length
				? { ...config, enabledTools: [...new Set([...config.enabledTools, ...setup])] }
				: config;
		});
		for (const id of this.supervisor.ids()) {
			const current = this.configurations.find((c) => c.id === id);
			if (!current || JSON.stringify(current) !== JSON.stringify(this.supervisor.config(id)))
				await this.supervisor.remove(id);
		}
		this.supervisor.configure(
			this.configurations.filter((c) => !this.supervisor.ids().includes(c.id)),
		);
	}
	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const task = this.mutations
			.catch(() => {})
			.then(async () => {
				if (this.stopped) throw new Error("Laplace Desktop is stopping");
				if (this.syncing) await this.syncing.catch(() => {});
				return work();
			});
		this.mutations = task;
		return task;
	}
	getServerConfig(id: string): ServerConfig {
		const value = this.configurations.find((c) => c.id === id);
		if (!value) throw new Error("Unknown connector");
		return structuredClone(value);
	}
	browserSetupConfig(id: string) {
		return this.browserStages.get(id)?.config ?? this.getServerConfig(id);
	}
	async browserMigrationRecords() {
		return (await this.store.read()).browserMigrations ?? [];
	}
	async prepareBrowserMigration(record: BrowserMigration) {
		await verifyBrowserConfiguration(this.resources, record.candidate);
		return this.serialize(async () => {
			await this.store.mutate((state) => {
				if (
					state.browserMigrations?.some(
						(r) => r.serverId === record.serverId && ["prepared", "committing"].includes(r.state),
					)
				)
					throw Error(
						"An interrupted migration is pending. Use Repair to restore it before retrying.",
					);
				const index = state.servers.findIndex((s) => s.id === record.serverId);
				if (index < 0 || canonicalJson(state.servers[index]) !== canonicalJson(record.previous))
					throw Error("Connection changed before migration.");
				(state.browserMigrations ??= []).push(record);
				state.servers[index] = { ...record.previous, enabled: false };
			});
			this.epoch++;
			await this.reload();
			this.browserStages.set(
				record.serverId,
				new BrowserMigrationStage(this.root, this.resources, record),
			);
			this.changed();
		});
	}
	async completeBrowserMigration(migrationId: string) {
		return this.serialize(async () => {
			const record = (await this.browserMigrationRecords()).find((r) => r.id === migrationId);
			if (!record || record.state !== "prepared" || !this.browserStages.has(record.serverId))
				throw Error("Migration is not ready.");
			await this.store.mutate((state) => {
				const saved = state.browserMigrations?.find((r) => r.id === record.id),
					current = state.servers.find((s) => s.id === record.serverId);
				if (
					!saved ||
					saved.state !== "prepared" ||
					canonicalJson(current) !== canonicalJson({ ...record.previous, enabled: false })
				)
					throw Error("Connection changed during migration.");
				saved.state = "committing";
			});
			await this.store.mutate((state) => {
				const saved = state.browserMigrations?.find((r) => r.id === record.id),
					index = state.servers.findIndex((s) => s.id === record.serverId);
				if (
					!saved ||
					saved.state !== "committing" ||
					index < 0 ||
					canonicalJson(state.servers[index]) !==
						canonicalJson({ ...record.previous, enabled: false })
				)
					throw Error("Connection changed during migration.");
				state.servers[index] = record.candidate;
				saved.state = "complete";
			});
			await this.browserStages.get(record.serverId)?.close();
			this.browserStages.delete(record.serverId);
			this.epoch++;
			await this.reload();
			if (record.candidate.enabled) await this.supervisor.start(record.serverId);
			await this.refresh().catch(() => {});
			this.changed();
		});
	}
	async rollbackBrowserMigration(migrationId: string) {
		return this.serialize(async () => {
			const record = (await this.browserMigrationRecords()).find((r) => r.id === migrationId);
			if (!record || record.state === "cancelled") throw Error("No pending migration.");
			await this.browserStages.get(record.serverId)?.close();
			this.browserStages.delete(record.serverId);
			await this.store.mutate((state) => {
				const saved = state.browserMigrations?.find((r) => r.id === record.id),
					index = state.servers.findIndex((s) => s.id === record.serverId);
				if (
					!saved ||
					index < 0 ||
					![
						canonicalJson(record.candidate),
						canonicalJson({ ...record.previous, enabled: false }),
					].includes(canonicalJson(state.servers[index]))
				)
					throw Error("Connection changed; recovery preserved it for manual review.");
				state.servers[index] = record.previous;
				saved.state = "cancelled";
			});
			this.epoch++;
			await this.reload();
			if (record.previous.enabled) await this.supervisor.start(record.serverId);
			await this.refresh().catch(() => {});
			this.changed();
		});
	}

	listServers(): ServerSnapshot[] {
		return this.configurations.map((config) => {
			const runtime = this.supervisor.states().find((s) => s.id === config.id);
			const allowed = this.effectiveTools(config.id);
			const localLimit = !this.isLinked(config.id) ? this.state.localLimits[config.id] : undefined;
			return {
				id: config.id,
				access: this.accessFor(config.id),
				name: config.name,
				transport: config.transport,
				enabled: config.enabled,
				status: runtime?.status ?? "stopped",
				diagnostic: runtime?.diagnostic ?? [],
				installedVersion: runtime?.installedVersion,
				linkMode: !this.isLinked(config.id)
					? "local-only"
					: this.cloud && !this.explicitlyBlocked && !this.state.linking
						? "linked"
						: "blocked",
				cloudEnabled: this.isLinked(config.id)
					? this.cloud?.connections.find((c) => c.localId === config.id)?.enabled
					: undefined,
				...(config.transport === "stdio"
					? {
							command: config.command,
							args: configurationSummary(config).args,
							argumentCount: config.args.length,
							cwd: config.cwd,
							secretKeys: Object.keys(config.env),
						}
					: {
							url: new URL(config.url).origin + new URL(config.url).pathname,
							secretKeys: Object.keys(config.headers),
						}),
				tools: (runtime?.tools ?? [])
					.filter(
						(tool) =>
							![slackBrowserIdentity, ycBrowserIdentity].includes(config.identity ?? "") ||
							(!tool.name.startsWith("laplace_browser_") && tool.name !== "laplace_slack_verify"),
					)
					.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
						localEnabled:
							(!config.enabledTools || config.enabledTools.includes(tool.name)) &&
							(!localLimit || (localLimit.enabled && localLimit.tools.includes(tool.name))),
						enabled: allowed.includes(tool.name),
					})),
			};
		});
	}
	private isLinked(id: string) {
		return this.state.mode === "linked" && !this.state.localOnly[id];
	}
	accessFor(id: string): ConnectorAccess {
		return this.state.access[id] ?? { visible: this.isLinked(id), remoteEnabled: false };
	}
	async setAccess(id: string, value: ConnectorAccess) {
		this.getServerConfig(id);
		const access = connectorAccess.parse(value);
		return this.serialize(async () => {
			this.epoch++;
			await this.save((s) => {
				s.access[id] = access;
			});
			await this.refresh();
			if (this.state.mode === "linked" && !this.explicitlyBlocked) {
				await (
					await this.api()
				).post("portable-access", { localId: id, access, enabledTools: this.effectiveTools(id) });
				await this.refresh();
			}
			this.changed();
			return this.status();
		});
	}
	async remoteTools(id: string, revision: string) {
		await this.refresh();
		const access = this.accessFor(id);
		const permission = this.cloud?.connections.find((c) => c.localId === id);
		const runtime = this.supervisor.states().find((s) => s.id === id);
		if (
			this.explicitlyBlocked ||
			this.state.mode !== "linked" ||
			!access.visible ||
			!access.remoteEnabled ||
			!permission?.enabled ||
			runtime?.revision !== revision
		)
			throw new Error("Remote connector unavailable or access denied");
		return runtime.tools.filter(
			(t) => permission.enabledTools.includes(t.name) && this.effectiveTools(id).includes(t.name),
		);
	}
	async remoteCall(
		id: string,
		revision: string,
		tool: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
	) {
		const tools = await this.remoteTools(id, revision);
		if (!tools.some((t) => t.name === tool)) throw new Error("Remote tool access denied");
		const invocation: Invocation = { localId: id, revision, tool, input };
		this.invocations.set(invocation, this.epoch);
		this.remoteInvocations.add(invocation);
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		try {
			return await this.supervisor.call(invocation, Date.now() + 180_000, controller);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	private effectiveTools(id: string) {
		const runtime = this.supervisor.states().find((s) => s.id === id),
			config = this.configurations.find((s) => s.id === id);
		if (!runtime || !config?.enabled) return [];
		const tools = runtime.tools
			.filter(
				(t) =>
					![slackBrowserIdentity, ycBrowserIdentity].includes(config.identity ?? "") ||
					(!t.name.startsWith("laplace_browser_") && t.name !== "laplace_slack_verify"),
			)
			.filter((t) => !config.enabledTools || config.enabledTools.includes(t.name))
			.map((t) => t.name);
		if (!this.isLinked(id)) {
			const limit = this.state.localLimits[id];
			return !limit
				? tools
				: limit.enabled
					? tools.filter((name) => limit.tools.includes(name))
					: [];
		}
		if (!this.cloud || this.explicitlyBlocked || this.state.linking) return [];
		const permission = this.cloud.connections.find((c) => c.localId === id);
		return permission?.enabled && permission.catalogRevision === runtime.revision
			? tools.filter((name) => permission.enabledTools.includes(name))
			: [];
	}
	status(): DesktopSnapshot {
		const mode =
			this.state.mode === "local-only"
				? "local-only"
				: this.state.linking
					? "linking"
					: !this.cloud || this.explicitlyBlocked
						? "linked-blocked"
						: "linked";
		return {
			mode,
			credentialRequests: this.credentialRequests(),
			mcp: this.mcpDiagnostics(),
			origin: this.state.origin,
			error: this.error,
			accountId: this.state.pairing?.accountId,
			installationId: this.state.pairing?.installationId,
			servers: this.listServers(),
			clients: this.listClients(),
			localTools: this.localToolChoices(),
			jobs: this.jobs(),
			endpoint: this.endpoint,
			runId: this.runId,
			stayLocalOnly: this.state.stayLocalOnly,
		};
	}
	async addServers(
		values: ServerConfig[],
		migrated = false,
		options: { authorize?: () => void; onSaved?: () => void; localOnly?: boolean } = {},
	) {
		const configs = values.map((value) =>
			serverConfig.parse(migrated ? { ...value, enabled: false } : value),
		);
		if (new Set(configs.map((c) => c.id)).size !== configs.length)
			throw new Error("Duplicate connector IDs");
		return this.serialize(async () => {
			options.authorize?.();
			// Mark only new IDs local before reload can publish them to a linked account.
			if (
				configs.some((config) => this.configurations.some((existing) => existing.id === config.id))
			)
				throw new Error("Connector ID already exists");
			await this.save((state) => {
				options.authorize?.();
				for (const config of configs) {
					state.localOnly[config.id] = options.localOnly ?? true;
					state.access[config.id] = { ...defaultConnectorAccess };
				}
			});
			if (migrated)
				await this.save((state) => {
					for (const config of configs) state.migrationPending[config.id] = true;
				});
			await this.store.mutate((state) => {
				options.authorize?.();
				for (const config of configs) {
					if (state.servers.some((s) => s.id === config.id))
						throw new Error(`Connector ${config.id} already exists`);
					state.servers.push(config);
				}
			});
			options.onSaved?.();
			await this.reload();
			options.authorize?.();
			const results = await Promise.allSettled(
				configs.filter((c) => c.enabled).map((c) => this.supervisor.start(c.id)),
			);
			await this.refresh().catch(() => {});
			this.changed();
			if (results.some((r) => r.status === "rejected"))
				throw new Error("Connector saved but startup failed. Review its diagnostics and retry.");
			return this.listServers();
		});
	}
	/** Internal verified-release replacement; never exposed as an arbitrary IPC operation. */
	updateMaintenance = () => false;
	async replaceManagedUpdate(config: ServerConfig, expected?: ServerConfig) {
		return this.serialize(async () => {
			this.epoch++;
			await this.store.mutate((state) => {
				const current = state.servers.find((c) => c.id === config.id);
				if (!current) throw Error("Connector removed during update");
				if (expected && JSON.stringify(current) !== JSON.stringify(expected))
					throw Error("Connector changed before atomic update switch");
				state.servers = state.servers.map((c) => (c.id === config.id ? config : c));
			});
			await this.reload();
			if (config.enabled) await this.supervisor.start(config.id);
			this.changed();
		});
	}
	async updateServer(id: string, value: unknown) {
		const previous = this.getServerConfig(id);
		const patch = z.record(z.string(), z.unknown()).parse(value);
		if ("identity" in patch && patch.identity !== previous.identity)
			throw new Error("Catalog provenance cannot be assigned manually");
		const launchChanged = ["command", "args", "cwd", "env", "url", "headers", "transport"].some(
			(key) =>
				key in patch &&
				JSON.stringify(patch[key]) !==
					JSON.stringify((previous as unknown as Record<string, unknown>)[key]),
		);
		const config = serverConfig.parse({
			...previous,
			...patch,
			id,
			identity: launchChanged ? undefined : previous.identity,
			generation: randomUUID(),
		});
		return this.serialize(async () => {
			if (config.enabled && this.state.migrationPending[id])
				await assertLegacyProcessesStopped(config);
			this.epoch++;
			await this.store.mutate((s) => {
				s.servers = s.servers.map((c) => (c.id === id ? config : c));
			});
			await this.reload();
			if (config.enabled) {
				await this.supervisor.start(id);
				if (this.state.migrationPending[id])
					await this.save((state) => {
						delete state.migrationPending[id];
					});
			}
			await this.refresh().catch(() => {});
			this.changed();
			return this.listServers();
		});
	}
	async setEnabled(id: string, enabled: boolean) {
		return this.updateServer(id, { enabled });
	}
	async restartServer(id: string) {
		if (!this.getServerConfig(id).enabled) return this.setEnabled(id, true);
		return this.serialize(async () => {
			await this.supervisor.start(id, true);
			await this.refresh().catch(() => {});
			return this.listServers();
		});
	}
	async setTools(id: string, names: string[]) {
		const known = this.supervisor.states().find((s) => s.id === id)?.tools ?? [];
		if (
			new Set(names).size !== names.length ||
			names.some((name) => !known.some((t) => t.name === name))
		)
			throw new Error("Select known tools only");
		await this.save((s) => {
			delete s.localLimits[id];
		});
		return this.updateServer(id, { enabledTools: names });
	}
	async setServerLink(id: string, linked: boolean) {
		this.getServerConfig(id);
		if (linked && this.state.mode !== "linked") throw new Error("Link a Laplace account first");
		return this.serialize(async () => {
			this.epoch++;
			await this.save((state) => {
				if (!linked && this.isLinked(id)) {
					const permission = state.lastPermissions?.connections.find((c) => c.localId === id);
					state.localLimits[id] = {
						enabled: !!permission?.enabled,
						tools: permission?.enabledTools ?? [],
					};
				}
				state.localOnly[id] = !linked;
				state.access[id] = { visible: true, remoteEnabled: linked };
			});
			await this.refresh().catch(() => {});
			this.changed();
			return this.status();
		});
	}
	async removeServer(id: string) {
		this.getServerConfig(id);
		return this.serialize(async () => {
			this.epoch++;
			await this.supervisor.remove(id);
			await this.store.mutate((s) => {
				s.servers = s.servers.filter((c) => c.id !== id);
			});
			await this.reload();
			if (this.state.mode === "linked") {
				try {
					await (await this.api()).post("remove", { localId: id });
				} catch {
					this.error = "Removed locally; cloud removal could not be confirmed.";
				}
			}
			this.changed();
			return this.listServers();
		});
	}
	localToolChoices() {
		return [
			{ name: desktopManagementTool.name, title: "Desktop: configuration and diagnostics" },
			...connectorManagementTools.map((tool) => ({ name: tool.name, title: tool.title! })),
			{ name: "local_credentials", title: "Bitwarden: use credentials" },
			...this.supervisor.states().flatMap((s) =>
				s.tools.map((t) => ({
					name: scopedToolName(s.id, t.name, digest),
					title: `${s.name}: ${t.name}`,
				})),
			),
		];
	}
	clientToolAllowed(clientId: string, name: string) {
		const client = this.state.clients.find((c) => c.id === clientId && c.enabled);
		return !!client && (!client.allowedLocalTools || client.allowedLocalTools.includes(name));
	}
	tools(clientId?: string) {
		return this.supervisor
			.states()
			.flatMap((s) =>
				s.status === "online"
					? s.tools
							.filter(
								(t) =>
									this.effectiveTools(s.id).includes(t.name) &&
									(!clientId ||
										this.clientToolAllowed(clientId, scopedToolName(s.id, t.name, digest))),
							)
							.map((t) => localConnectorTool(t, s, digest))
					: [],
			);
	}
	async callNamed(
		name: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
		clientId?: string,
	) {
		for (const server of this.supervisor.states())
			for (const tool of server.tools)
				if (scopedToolName(server.id, tool.name, digest) === name)
					return this.call(server.id, tool.name, input, signal, clientId);
		throw new Error("Unknown local tool");
	}
	async call(
		id: string,
		tool: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
		clientId?: string,
	) {
		const epoch = this.epoch;
		if (this.isLinked(id)) await this.refresh();
		if (this.stopped || epoch !== this.epoch)
			throw new Error("Permissions changed before dispatch");
		if (clientId && !this.clientToolAllowed(clientId, scopedToolName(id, tool, digest)))
			throw new Error("This tool is disabled for this AI client");
		if (!this.effectiveTools(id).includes(tool))
			throw new Error(
				this.isLinked(id)
					? "Cloud permission or authorization unavailable. Review the linked account's tool permissions."
					: "Tool disabled or unavailable",
			);
		const state = this.supervisor.states().find((s) => s.id === id);
		if (!state?.revision) throw new Error("Connector not ready");
		const invocation: Invocation = { localId: id, tool, input, revision: state.revision };
		this.invocations.set(invocation, this.epoch);
		if (clientId) this.invocationClients.set(invocation, clientId);
		const controller = new AbortController(),
			abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		try {
			return await this.supervisor.call(invocation, Date.now() + 180_000, controller);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	/** Only named catalog checks; MCP setup uses the same installer, never arbitrary calls. */
	async catalogSetupCall(
		id: string,
		tool: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
	) {
		const stage = this.browserStages.get(id);
		if (stage) return stage.call(tool, input, signal);
		const config = this.getServerConfig(id);
		const entry = allBundleCatalog.find(
			(entry) => config.identity === `${entry.id}@${entry.version}`,
		);
		const managed = config.managedBrowser
			? await verifyBrowserConfiguration(this.resources, config)
			: undefined;
		const safe: Record<string, string[]> = {
			"yc-demo": [
				"list_applications",
				"laplace_browser_pair",
				"laplace_browser_status",
				"laplace_browser_review",
				"laplace_browser_authorize",
				"laplace_browser_focus",
				"laplace_browser_revoke",
			],
			canvas: ["canvas_whoami", "canvas_list_courses"],
			linkedin: ["get_my_profile"],
			"yale-som-ems": ["ems_session_status", "ems_list_templates"],
			outlook: ["outlook_login", "outlook_status", "outlook_list_folders"],
			"slack-ready": [
				"channels_list",
				"laplace_browser_pair",
				"laplace_browser_status",
				"laplace_browser_review",
				"laplace_browser_authorize",
				"laplace_browser_focus",
				"laplace_browser_revoke",
			],
		};
		if (
			(!managed && !entry) ||
			!(
				managed
					? [...browserSetupTools, browserProviders[managed.provider].verify]
					: (safe[entry!.recipe] ?? [])
			).includes(tool) ||
			(Object.keys(input).length &&
				!["laplace_browser_authorize", "laplace_browser_focus"].includes(tool))
		)
			throw new Error("Only the catalog's named setup checks are allowed");
		const runtime = this.supervisor.states().find((s) => s.id === id);
		if (!runtime?.revision) throw new Error("Connector not ready");
		const invocation: Invocation = { localId: id, tool, input, revision: runtime.revision };
		this.invocations.set(invocation, this.epoch);
		this.setupInvocations.add(invocation);
		const controller = new AbortController(),
			abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		try {
			return await (
				managed
					? this.supervisor.callBrowserSetup.bind(this.supervisor)
					: this.supervisor.call.bind(this.supervisor)
			)(invocation, Date.now() + (tool === "outlook_login" ? 15 * 60_000 : 180_000), controller);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	private async authorize(invocation: Invocation) {
		const epoch = this.invocations.get(invocation);
		if (this.stopped || epoch !== this.epoch)
			throw new Error("Permissions changed before dispatch");
		if (this.setupInvocations.has(invocation)) return;
		const config = this.getServerConfig(invocation.localId);
		if (config.managedBrowser) await verifyBrowserConfiguration(this.resources, config);
		const clientId = this.invocationClients.get(invocation);
		if (
			clientId &&
			!this.clientToolAllowed(clientId, scopedToolName(invocation.localId, invocation.tool, digest))
		)
			throw new Error("This tool is disabled for this AI client");
		if (!this.effectiveTools(invocation.localId).includes(invocation.tool))
			throw new Error("Permissions changed before dispatch");
		const remote = this.remoteInvocations.has(invocation);
		if (
			remote &&
			(!this.accessFor(invocation.localId).remoteEnabled ||
				!this.accessFor(invocation.localId).visible)
		)
			throw new Error("Remote access disabled");
		if (!this.isLinked(invocation.localId) && !remote) return;
		const permission = this.cloud?.connections.find((c) => c.localId === invocation.localId);
		if (!permission) throw new Error("Cloud permission unavailable");
		try {
			const result = await (
				await this.api()
			).post("authorize", {
				runId: this.runId,
				localId: invocation.localId,
				tool: invocation.tool,
				catalogRevision: invocation.revision,
				permissionRevision: permission.permissionRevision,
				...(remote ? { remote: true } : {}),
			});
			if (
				!z
					.object({ authorized: z.literal(true) })
					.strict()
					.safeParse(result).success
			)
				throw new Error();
		} catch {
			this.cloud = undefined;
			this.error = "Cloud authorization unavailable or denied. Linked tools are blocked.";
			this.changed();
			throw new Error(this.error);
		}
		if (
			epoch !== this.epoch ||
			this.state.mode !== "linked" ||
			this.explicitlyBlocked ||
			(clientId &&
				!this.clientToolAllowed(
					clientId,
					scopedToolName(invocation.localId, invocation.tool, digest),
				))
		)
			throw new Error("Permissions changed before dispatch");
	}
	private async api() {
		if (!this.state.pairing) throw new Error("Link this installation first");
		const token = await this.store.credential();
		if (!token) throw new Error("Installation credential unavailable");
		return this.apiFactory(this.state.pairing.origin, token);
	}
	async credentialRelayApi() {
		if (this.status().mode !== "linked") throw new Error("Linked account unavailable");
		return this.api();
	}
	private async publish(publication: Publication) {
		if (
			this.state.mode !== "linked" ||
			!this.accessFor(publication.localId).visible ||
			this.state.linking ||
			this.explicitlyBlocked
		)
			return;
		const config = this.configurations.find((s) => s.id === publication.localId);
		try {
			await (
				await this.api()
			).post("discovery", {
				...publication,
				initialEnabled: config?.enabled ?? false,
				initialEnabledTools: publication.toolNames.filter(
					(name) => !config?.enabledTools || config.enabledTools.includes(name),
				),
			});
		} catch {
			this.cloud = undefined;
			this.error = "Cloud synchronization unavailable. Linked tools are blocked.";
			this.changed();
		}
	}
	refresh() {
		if (this.syncing) return this.syncing;
		this.syncing = this.sync().finally(() => {
			this.syncing = undefined;
		});
		return this.syncing;
	}
	private async sync() {
		if (this.stopped) return;
		await this.flushRevocations();
		if (this.state.mode !== "linked" || this.state.linking || this.explicitlyBlocked) return;
		const epoch = this.epoch;
		const before = canonicalJson({ cloud: this.cloud ?? null, error: this.error ?? null });
		try {
			const api = await this.api();
			await this.supervisor.republish();
			for (const config of this.configurations) {
				if (this.supervisor.states().find((s) => s.id === config.id)?.revision) continue;
				await this.publish({
					localId: config.id,
					name: config.name,
					catalog: config.catalog,
					identity: config.identity,
					revision: digest(canonicalJson([config.id, config.generation, []])),
					installedVersion: "unknown",
					installedRevision: config.generation,
					toolNames: [],
				});
			}
			await api
				.post("portable-sync", {
					access: Object.fromEntries(this.configurations.map((c) => [c.id, this.accessFor(c.id)])),
					snapshots: this.portableSnapshots().filter((s) => this.accessFor(s.id).visible),
				})
				.catch((error) => {
					if (!(error instanceof LocalApiError && error.status === 404)) throw error;
				});
			const config = configurationSchema.parse(await api.post("configuration", {}));
			if (epoch !== this.epoch) return;
			if (
				config.installationId !== this.state.pairing?.installationId ||
				config.accountId !== this.state.pairing.accountId
			)
				throw new Error();
			if (epoch !== this.epoch) return;
			this.cloud = config;
			this.error = undefined;
			await this.save((state) => {
				state.lastPermissions = config;
			});
		} catch {
			this.cloud = undefined;
			this.error =
				"Cloud authorization unavailable. Linked tools remain blocked; reconnect or explicitly unlink.";
		}
		if (before !== canonicalJson({ cloud: this.cloud ?? null, error: this.error ?? null }))
			this.changed();
	}
	async prepareLink(origin: string) {
		const base = connectorOriginSchema.parse(origin);
		const generation = this.blockGeneration;
		return this.serialize(async () => {
			if (generation !== this.blockGeneration) throw new Error("Sign-in was cancelled");
			if (this.state.pairing && this.state.pairing.origin !== base)
				throw new Error(
					"Existing link belongs to another environment. Use a separate desktop profile.",
				);
			const token = randomBytes(32).toString("base64url");
			(await this.entries("installation-pending")).setPassword(token);
			this.epoch++;
			this.cloud = undefined;
			this.explicitlyBlocked = generation !== this.blockGeneration;
			await this.save((state) => {
				state.mode = "linked";
				state.linking = true;
				state.blocked = generation !== this.blockGeneration;
				state.origin = base;
				state.stayLocalOnly = false;
			});
			this.changed();
			return {
				credentialHash: credentialDigest(token),
				installationId: this.state.pairing?.installationId,
			};
		});
	}
	async completeLink(value: z.infer<typeof pairing>) {
		const next = pairing.parse(value);
		const generation = this.blockGeneration;
		return this.serialize(async () => {
			if (generation !== this.blockGeneration) throw new Error("Sign-in was cancelled");
			if (this.state.origin !== next.origin || !this.state.linking)
				throw new Error("No matching link is pending");
			const entry = await this.entries("installation-pending"),
				token = entry.getPassword();
			if (!token) throw new Error("Link credential unavailable; start linking again");
			await this.store.credential(token);
			await this.save((s) => {
				s.pairing = next;
				s.linking = false;
				s.blocked = generation !== this.blockGeneration;
				s.mode = "linked";
			});
			entry.deletePassword();
			this.epoch++;
			this.explicitlyBlocked = generation !== this.blockGeneration;
			await this.refresh();
			this.changed();
			return this.status();
		});
	}
	async blockLink() {
		this.blockGeneration++;
		this.epoch++;
		this.cloud = undefined;
		this.explicitlyBlocked = true;
		this.error = "Sign in again to use linked tools, or explicitly unlink for local use.";
		this.changed();
		return this.serialize(async () => {
			try {
				await this.save((s) => {
					s.blocked = true;
					s.linking = false;
				});
			} finally {
				this.epoch++;
				this.cloud = undefined;
				this.explicitlyBlocked = true;
				this.error = "Sign in again to use linked tools, or explicitly unlink for local use.";
				this.changed();
			}
			return this.status();
		});
	}
	async unlink() {
		return this.serialize(async () => {
			this.epoch++;
			this.cloud = undefined;
			if (this.state.mode === "linked")
				await this.save((state) => {
					for (const config of this.configurations.filter((c) => !state.localOnly[c.id])) {
						const permission = state.lastPermissions?.connections.find(
							(c) => c.localId === config.id,
						);
						state.localLimits[config.id] = {
							enabled: !!permission?.enabled,
							tools: permission?.enabledTools ?? [],
						};
					}
				});
			const token = await this.store.credential();
			if (token && this.state.pairing) {
				const key = `revoke:${randomUUID()}`;
				(await this.entries(key)).setPassword(token);
				await this.save((s) => {
					s.revocations.push({ origin: s.pairing!.origin, key });
				});
			}
			await this.store.clearCredential();
			try {
				(await this.entries("installation-pending")).deletePassword();
			} catch {}
			await this.save((state) => {
				state.mode = "local-only";
				state.stayLocalOnly = true;
				state.linking = false;
				state.blocked = false;
			});
			this.explicitlyBlocked = false;
			this.error = undefined;
			await this.reload();
			await Promise.allSettled(
				this.configurations.filter((c) => c.enabled).map((c) => this.supervisor.start(c.id)),
			);
			await this.flushRevocations();
			this.changed();
			return this.status();
		});
	}
	private async flushRevocations() {
		for (const revocation of [...this.state.revocations]) {
			try {
				const entry = await this.entries(revocation.key),
					token = entry.getPassword();
				if (token) await this.apiFactory(revocation.origin, token).post("revoke", {});
				await this.save((s) => {
					s.revocations = s.revocations.filter((r) => r.key !== revocation.key);
				});
				if (token) entry.deletePassword();
			} catch {
				this.error =
					"Local-only mode is active. Cloud credential revocation will retry when available.";
			}
		}
	}
	listClients(): ClientSnapshot[] {
		return this.state.clients.map(({ tokenHash: _, ...client }) => ({
			...client,
			...this.hostedStatus(client.id),
		}));
	}
	async registerClient(name: string) {
		const id = randomUUID(),
			token = randomBytes(32).toString("base64url");
		const entry = await this.entries(`client:${id}`);
		entry.setPassword(token);
		try {
			await this.save((s) => {
				s.clients.push({
					id,
					name: z.string().trim().min(1).max(80).parse(name),
					enabled: true,
					tokenHash: credentialDigest(token),
					createdAt: new Date().toISOString(),
				});
			});
		} catch (error) {
			entry.deletePassword();
			throw error;
		}
		this.changed();
		return { id, name };
	}
	client(id: string) {
		const value = this.state.clients.find((c) => c.id === id && c.enabled);
		if (!value) throw new Error("AI client disabled or unknown");
		return { id: value.id, name: value.name };
	}
	authenticateClient(token: string) {
		const value = this.state.clients.find(
			(c) => c.enabled && c.tokenHash === credentialDigest(token),
		);
		return value ? { id: value.id, name: value.name } : undefined;
	}
	async setClientTools(id: string, names: string[] | null) {
		this.client(id);
		if (
			names &&
			(new Set(names).size !== names.length ||
				names.some((name) => !this.localToolChoices().some((tool) => tool.name === name)))
		)
			throw new Error("Select known local tools only");
		await this.save((s) => {
			const client = s.clients.find((c) => c.id === id)!;
			if (names === null) delete client.allowedLocalTools;
			else client.allowedLocalTools = names;
		});
		this.changed();
		return this.listClients();
	}
	async revokeClient(id: string) {
		this.client(id);
		await this.save((s) => {
			s.clients.find((c) => c.id === id)!.enabled = false;
		});
		try {
			(await this.entries(`client:${id}`)).deletePassword();
		} catch {}
		this.changed();
		return { revoked: true };
	}
	async shutdown() {
		this.stopped = true;
		this.epoch++;
		await Promise.all([...this.browserStages.values()].map((stage) => stage.close()));
		this.browserStages.clear();
		await this.supervisor.shutdown();
	}
}
