import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Validator } from "@cfworker/json-schema";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { browserProviders } from "@repo/browser-runtime/browser-approval";
import {
	canonicalJson,
	toolSnapshot,
	type LocalTool,
	LOCAL_MCP_VERSION,
	type Invocation,
	type Publication,
} from "@repo/project-protocol/local-mcp";

import { browserSetupTools, verifyBrowserConfiguration } from "./browser-catalog";
import { runtimeCommand, type ServerConfig } from "./config";
import { InvocationQueue } from "./invocation-queue";
import { acquireResourceLeases, outlookIdentity } from "./leases";
import { closeMcpConnection } from "./mcp-lifecycle";
import { ManagedStdio } from "./process";

export interface ServerState {
	id: string;
	name: string;
	status: "stopped" | "starting" | "online" | "paused" | "needs_attention";
	tools: LocalTool[];
	enabledTools?: string[];
	revision?: string;
	identity?: string;
	installedVersion?: string;
	diagnostic: string[];
}
interface Runtime {
	config: ServerConfig;
	state: ServerState;
	client?: Client;
	transport?: ManagedStdio | StreamableHTTPClientTransport;
	starting?: Promise<void>;
	queue: InvocationQueue;
	crashes: number[];
	stopping: boolean;
	manualRestartRequired?: boolean;
	aborts: Set<AbortController>;
	releaseLeases?: () => Promise<void>;
}
const emsIdentity = (identity?: string) => /^(?:npm:@withlaplace\/)?yale-som-ems-mcp@/.test(identity ?? "");

function verifiedBackgroundEnvironment(identity?: string): Record<string, string> {
	if (/^(?:npm:@withlaplace\/)?canvas-session-mcp@/.test(identity ?? "")) {
		return {
			CANVAS_MCP_VERIFIED_CHECK_ORIGIN: process.env.CANVAS_MCP_VERIFIED_CHECK_ORIGIN ?? "",
			CANVAS_MCP_VERIFIED_CHECK_MINUTES: process.env.CANVAS_MCP_VERIFIED_CHECK_MINUTES ?? "",
		};
	}
	if (emsIdentity(identity)) {
		return { EMS_VERIFIED_CHECK_MINUTES: process.env.EMS_VERIFIED_CHECK_MINUTES ?? "" };
	}
	return {};
}

export class Supervisor {
	private closed = false;
	private maintenance = false;
	get maintenanceActive() {
		return this.maintenance;
	}
	private connectorMaintenance = new Set<string>();
	tryConnectorMaintenance(id: string) {
		const runtime = this.server(id);
		if (
			this.maintenance ||
			this.connectorMaintenance.has(id) ||
			runtime.starting ||
			runtime.manualRestartRequired ||
			runtime.queue.activity.active ||
			runtime.queue.activity.queued
		)
			return;
		this.connectorMaintenance.add(id);
		return () => {
			this.connectorMaintenance.delete(id);
		};
	}

	activity() {
		return [...this.servers.values()].some(
			(r) =>
				r.starting || r.queue.activity.active || r.queue.activity.queued || r.manualRestartRequired,
		);
	}
	tryMaintenance() {
		if (this.maintenance || this.connectorMaintenance.size || this.activity()) return;
		this.maintenance = true;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.maintenance = false;
			}
		};
	}

	private browserSetup = new WeakSet<Invocation>();
	private servers = new Map<string, Runtime>();
	private sessionSecrets = new Map<string, string[]>();
	private timers = new Set<ReturnType<typeof setTimeout>>();
	constructor(
		private root: string,
		private resources: string,
		private changed: () => void,
		private publish: (publication: Publication) => Promise<void>,
		private authorize: (invocation: Invocation) => Promise<void>,
	) {}
	configure(configs: ServerConfig[]) {
		for (const config of configs) {
			if (this.servers.has(config.id)) throw new Error("Duplicate server ID");
			this.servers.set(config.id, {
				config,
				state: {
					id: config.id,
					name: config.name,
					status: "stopped",
					tools: [],
					enabledTools: config.enabledTools,
					identity: config.identity,
					diagnostic: [],
				},
				queue: new InvocationQueue(),
				crashes: [],
				stopping: false,
				aborts: new Set(),
			});
		}
		this.changed();
	}
	states() {
		return [...this.servers.values()].map(({ state }) => ({ ...state }));
	}
	ids() {
		return [...this.servers.keys()];
	}
	protectSession(id: string, values: string[]) {
		this.sessionSecrets.set(
			id,
			values.filter((value) => value.length >= 8),
		);
	}

	config(id: string) {
		return this.server(id).config;
	}
	private server(id: string) {
		const server = this.servers.get(id);
		if (!server) throw new Error("Unknown server");
		return server;
	}
	private diagnostic(runtime: Runtime, value: string) {
		let text = value;
		if (runtime.config.transport === "stdio")
			for (const secret of Object.values(runtime.config.env))
				if (secret) text = text.split(secret).join("[redacted]");
		if (runtime.config.transport === "http")
			for (const secret of Object.values(runtime.config.headers).flatMap((value) => [
				value,
				value.replace(/^Bearer /, ""),
			]))
				if (secret) text = text.split(secret).join("[redacted]");
		for (const secret of this.sessionSecrets.get(runtime.config.id) ?? [])
			text = text.split(secret).join("[redacted]");
		runtime.state.diagnostic = [...runtime.state.diagnostic.slice(-49), text];
		this.changed();
	}
	async start(id: string, manual = false): Promise<void> {
		const runtime = this.server(id);
		if (this.maintenance) throw new Error("Update maintenance in progress");
		if (this.closed) throw new Error("Supervisor stopped");
		if (!runtime.config.enabled) throw new Error("Server disabled");
		if (runtime.starting) return runtime.starting;
		if (runtime.client && runtime.state.status === "online" && !manual) return;
		if ((runtime.state.status === "needs_attention" || runtime.manualRestartRequired) && !manual)
			throw new Error("Manual restart required");
		if (manual) {
			if (runtime.client) await this.stop(id);
			runtime.crashes = [];
			runtime.manualRestartRequired = false;
		}
		runtime.starting = this.initialize(runtime)
			.catch(async (error) => {
				runtime.stopping = true;
				await closeMcpConnection(runtime.client, runtime.transport);
				runtime.transport = undefined;
				await runtime.releaseLeases?.();
				runtime.releaseLeases = undefined;
				runtime.client = undefined;
				runtime.state.status = "needs_attention";
				this.diagnostic(runtime, error instanceof Error ? error.message : "MCP startup failed");
				this.changed();
				throw error;
			})
			.finally(() => {
				runtime.starting = undefined;
			});
		return runtime.starting;
	}
	private async initialize(runtime: Runtime) {
		if (this.closed) throw new Error("Supervisor stopped");
		runtime.stopping = false;
		runtime.state.status = "starting";
		this.changed();
		const directory = join(this.root, "servers", runtime.config.id);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		if (this.closed || runtime.stopping) throw new Error("Supervisor stopped");
		const config = runtime.config;
		runtime.releaseLeases = await acquireResourceLeases(
			config,
			config.transport === "stdio" ? (config.cwd ?? directory) : directory,
		);
		if (this.closed || runtime.stopping) {
			await runtime.releaseLeases();
			runtime.releaseLeases = undefined;
			throw new Error("Supervisor stopped");
		}
		const transport =
			config.transport === "stdio"
				? new ManagedStdio({
						...runtimeCommand(config.command, config.args, this.resources),
						cwd: config.cwd ?? directory,
						home: homedir(),
						env: {
							...config.env,
							...verifiedBackgroundEnvironment(config.identity),
							...(process.env.LAPLACE_SESSION_RECOVERY_V1 === "true" &&
							outlookIdentity(config.identity)
								? { LAPLACE_SESSION_RECOVERY_V1: "true" }
								: {}),
						},
						resources: this.resources,
						gracefulShutdown: emsIdentity(config.identity),
						diagnostic: (message) => this.diagnostic(runtime, message),
					})
				: new StreamableHTTPClientTransport(new URL(config.url), {
						requestInit: { headers: config.headers, redirect: "error" },
						fetch: (url, init) => {
							if (new URL(url.toString()).origin !== new URL(config.url).origin)
								throw new Error("Local MCP origin changed");
							return fetch(url, { ...init, redirect: "error" });
						},
						reconnectionOptions: {
							maxRetries: 0,
							maxReconnectionDelay: 1000,
							initialReconnectionDelay: 1000,
							reconnectionDelayGrowFactor: 1,
						},
					});
		const client = new Client(
			{ name: "laplace-local", version: LOCAL_MCP_VERSION },
			{
				capabilities: {},
				versionNegotiation: {
					mode: config.protocolVersion ? { pin: config.protocolVersion } : "legacy",
				},
			},
		);
		runtime.client = client;
		runtime.transport = transport;
		client.setNotificationHandler("notifications/tools/list_changed", async () => {
			if (runtime.client !== client || runtime.stopping) return;
			runtime.state.status = "needs_attention";
			for (const controller of runtime.aborts) controller.abort();
			this.changed();
			await this.publishState(runtime).catch(() => {});
		});
		client.onclose = () => {
			if (!runtime.stopping && runtime.client === client) void this.crashed(runtime);
		};
		try {
			await client.connect(transport, { timeout: 30_000 });
			if (
				client.getProtocolEra() === "modern" &&
				client.getServerCapabilities()?.tools?.listChanged
			)
				await client.listen({ toolsListChanged: true });
			const tools: LocalTool[] = [];
			let cursor: string | undefined;
			const cursors = new Set<string>();
			do {
				const page = await client.listTools(cursor ? { cursor } : undefined, {
					timeout: 30_000,
				});
				tools.push(...page.tools.map((tool) => toolSnapshot.parse(tool)));
				cursor = page.nextCursor;
				if (tools.length > 300 || (cursor && cursors.has(cursor)))
					throw new Error("Invalid tool pagination");
				if (cursor) cursors.add(cursor);
			} while (cursor);
			if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
				throw new Error("Duplicate tools");
			if (this.closed || runtime.stopping) throw new Error("Supervisor stopped");
			runtime.state.tools = tools;
			const upstreamVersion = client.getServerVersion()?.version;
			runtime.state.installedVersion =
				upstreamVersion && /^[0-9A-Za-z.+_-]{1,64}$/.test(upstreamVersion)
					? upstreamVersion
					: "unknown";
			runtime.state.revision = createHash("sha256")
				.update(
					canonicalJson({
						generation: config.generation,
						catalog: config.catalog,
						identity: config.identity ?? null,
						tools,
						enabledTools: config.enabledTools ?? tools.map((tool) => tool.name),
					}),
				)
				.digest("hex");
			runtime.state.status = "online";
			this.changed();
			await this.publishState(runtime);
		} catch {
			runtime.stopping = true;
			await closeMcpConnection(client, transport);
			runtime.transport = undefined;
			await runtime.releaseLeases?.();
			runtime.releaseLeases = undefined;
			runtime.client = undefined;
			runtime.state.status = "needs_attention";
			this.changed();
			throw new Error("MCP startup or tool discovery failed");
		}
	}
	private async publishState(runtime: Runtime) {
		if (!runtime.state.revision) return;
		await this.publish({
			localId: runtime.config.id,
			name: runtime.config.name,
			catalog: runtime.config.catalog,
			identity: runtime.config.identity,
			revision: runtime.state.revision,
			installedVersion: runtime.state.installedVersion ?? "unknown",
			installedRevision: runtime.config.generation,
			toolNames: runtime.state.tools.map((tool) => tool.name),
		});
	}
	async republish() {
		for (const runtime of this.servers.values())
			if (runtime.state.revision) await this.publishState(runtime);
	}
	private async crashed(runtime: Runtime) {
		runtime.client = undefined;
		await closeMcpConnection(undefined, runtime.transport);
		runtime.transport = undefined;
		await runtime.releaseLeases?.();
		runtime.releaseLeases = undefined;
		runtime.state.status = "needs_attention";
		runtime.crashes = runtime.crashes.filter((at) => Date.now() - at < 300_000);
		this.changed();
		await this.publishState(runtime).catch(() => {});
		if (runtime.stopping || runtime.manualRestartRequired || runtime.crashes.length >= 3) return;
		runtime.crashes.push(Date.now());
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (!runtime.stopping && !runtime.manualRestartRequired)
				void this.start(runtime.config.id, false).catch(() => {});
		}, 1000);
		// Automatic retry is for process startup only. Operations are never retried.
		runtime.state.status = "stopped";
		this.timers.add(timer);
	}
	validate(invocation: Invocation) {
		const runtime = this.server(invocation.localId);
		const tool = runtime.state.tools.find((tool) => tool.name === invocation.tool);
		if (
			!runtime.config.enabled ||
			!runtime.client ||
			runtime.manualRestartRequired ||
			runtime.state.status !== "online" ||
			runtime.state.revision !== invocation.revision ||
			!tool ||
			(!this.browserSetup.has(invocation) &&
				runtime.config.enabledTools &&
				!runtime.config.enabledTools.includes(tool.name))
		)
			throw new Error("Tool changed or is unavailable");
		if (!new Validator(tool.inputSchema, "2020-12").validate(invocation.input).valid)
			throw new Error("Invalid tool arguments");
	}
	async callBrowserSetup(invocation: Invocation, expiresAt: number, controller: AbortController) {
		const receipt = await verifyBrowserConfiguration(
			this.resources,
			this.server(invocation.localId).config,
		);
		if (
			![...browserSetupTools, browserProviders[receipt.provider].verify].includes(
				invocation.tool,
			) ||
			(Object.keys(invocation.input).length &&
				!["laplace_browser_authorize", "laplace_browser_focus"].includes(invocation.tool))
		)
			throw Error("Only named browser setup checks may bypass the published tool limit.");
		this.browserSetup.add(invocation);
		try {
			return await this.call(invocation, expiresAt, controller);
		} finally {
			this.browserSetup.delete(invocation);
		}
	}

	call(invocation: Invocation, expiresAt: number, controller: AbortController) {
		if (this.maintenance || this.connectorMaintenance.has(invocation.localId))
			return Promise.reject(
				new Error("Tool call was not started: update maintenance; retry later"),
			);
		const runtime = this.server(invocation.localId);
		return runtime.queue.add(async () => {
			this.validate(invocation);
			if (controller.signal.aborted || expiresAt <= Date.now())
				throw new Error("Operation expired");
			// Authorization happens when queued work reaches dispatch, with identifiers only.
			await this.authorize(invocation);
			this.validate(invocation);
			if (controller.signal.aborted || expiresAt <= Date.now())
				throw new Error("Operation expired");
			runtime.aborts.add(controller);
			try {
				const result = await runtime.client!.callTool(
					{ name: invocation.tool, arguments: invocation.input },
					{ timeout: expiresAt - Date.now(), signal: controller.signal },
				);
				return result;
			} catch {
				runtime.manualRestartRequired = true;
				// Cancellation or a lost response may leave an MCP server still
				// executing. Stop managed stdio processes before permitting another
				// call; external HTTP servers require a manual status check/restart.
				if (this.servers.get(runtime.config.id) === runtime) {
					await this.stop(runtime.config.id);
					if (this.servers.get(runtime.config.id) === runtime) {
						runtime.state.status = "needs_attention";
						this.changed();
						await this.publishState(runtime).catch(() => {});
					}
				}
				throw new Error("Tool outcome is unknown; check the server before restarting");
			} finally {
				runtime.aborts.delete(controller);
			}
		}, controller.signal);
	}
	async stop(id: string) {
		const runtime = this.server(id);
		runtime.stopping = true;
		for (const controller of runtime.aborts) controller.abort();
		await closeMcpConnection(runtime.client, runtime.transport);
		runtime.transport = undefined;
		await runtime.releaseLeases?.();
		runtime.releaseLeases = undefined;
		runtime.client = undefined;
		runtime.state.status = "stopped";
		this.changed();
		await this.publishState(runtime).catch(() => {});
	}
	async remove(id: string) {
		await this.stop(id);
		this.servers.delete(id);
		this.changed();
	}
	async permissions(id: string, enabledTools: string[]) {
		const runtime = this.server(id);
		if (
			new Set(enabledTools).size !== enabledTools.length ||
			enabledTools.some((name) => !runtime.state.tools.some((tool) => tool.name === name))
		)
			throw new Error("Invalid tool permissions");
		const config = { ...runtime.config, enabledTools, generation: crypto.randomUUID() };
		await this.remove(id);
		this.configure([config]);
		await this.start(id, true);
		return config;
	}
	async shutdown() {
		this.closed = true;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		await Promise.all([...this.servers.keys()].map((id) => this.stop(id)));
	}
}
