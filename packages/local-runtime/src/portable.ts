import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { serverConfig } from "@repo/local-mcp-core/config";
import { EncryptedStore } from "@repo/local-mcp-core/encrypted-store";
import { canonicalJson } from "@repo/project-protocol/local-mcp";
import {
	reusableConnectorSettings,
	installRequest,
	managementCommand,
	localManagementRequest,
	portableOperation,
	portableSnapshot,
	type PortableOperation,
	type PortableSnapshot,
} from "@repo/project-protocol/portable-connectors";
import { satisfies, valid, validRange } from "semver";
import { z } from "zod";

import type { CatalogInstaller } from "./catalog";
import { bundleCatalog } from "./library-catalog";
import { extractBundle } from "./mcpb-archive";
import type { DesktopManager } from "./manager";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const launchOverride = z
	.object({
		command: z.string().optional(),
		args: z.array(z.string()).optional(),
		env: z.record(z.string(), z.string()).optional(),
	})
	.strict();
const manifestSchema = z.object({
	manifest_version: z.enum(["0.1", "0.2", "0.3"]),
	name: z.string().min(1).max(120),
	version: z
		.string()
		.min(1)
		.max(80)
		.refine((value) => valid(value) !== null),
	description: z.string().min(1),
	author: z.object({ name: z.string().min(1) }),
	server: z.object({
		type: z.enum(["node", "python", "binary"]),
		entry_point: z.string().optional(),
		mcp_config: z.object({
			command: z.string(),
			args: z.array(z.string()).default([]),
			env: z.record(z.string(), z.string()).default({}),
			platform_overrides: z
				.object({
					win32: launchOverride.optional(),
					darwin: launchOverride.optional(),
					linux: launchOverride.optional(),
				})
				.strict()
				.optional(),
		}),
	}),
	compatibility: z
		.object({
			platforms: z.array(z.enum(["win32", "darwin", "linux"])).optional(),
			runtimes: z.object({ node: z.string().optional(), python: z.string().optional() }).optional(),
		})
		.optional(),
	user_config: z
		.record(
			z.string(),
			z.object({
				type: z.enum(["string", "number", "boolean", "directory", "file"]),
				title: z.string().optional(),
				required: z.boolean().default(false),
				sensitive: z.boolean().default(false),
				multiple: z.literal(false).optional(),
				min: z.number().optional(),
				max: z.number().optional(),
				default: z.union([z.string(), z.number(), z.boolean()]).optional(),
			}),
		)
		.default({}),
});
const stateSchema = z.object({
	requests: z.record(z.string(), installRequest).default({}),
	commands: z
		.record(
			z.string(),
			z.object({
				fingerprint: z.string(),
				receipt: z.record(z.string(), z.unknown()),
				catalogJobId: z.string().optional(),
			}),
		)
		.default({}),
	operations: z.array(portableOperation).default([]),
	instances: z
		.record(
			z.string(),
			z.object({
				directory: z.string(),
				snapshot: portableSnapshot,
				custom: z.boolean(),
				artifact: z.string().optional(),
			}),
		)
		.default({}),
});
type State = z.infer<typeof stateSchema>;

/** Durable receipts contain no credentials, launch configuration, or tool payloads. */
/** The exact npm version a catalog snapshot copied, when it names the catalog's package. */
function pinnedVersion(
	entry: (typeof bundleCatalog)[number] | undefined,
	bundle: PortableSnapshot["bundle"],
) {
	return bundle.kind === "catalog" && bundle.package && entry?.npm?.package === bundle.package
		? bundle.version
		: undefined;
}
export class PortableConnectors {
	private store: EncryptedStore<State>;
	private state: State = { operations: [], instances: {}, commands: {}, requests: {} };
	private initializing?: Promise<void>;
	private queue: Promise<unknown> = Promise.resolve();
	private active = new Map<string, AbortController>();
	private remoteAllowed = new Set<string>();
	private commanding = new Set<string>();
	constructor(
		readonly manager: DesktopManager,
		readonly catalog: CatalogInstaller,
		readonly nodePath: string,
	) {
		this.store = new EncryptedStore(
			manager.root,
			"portable",
			stateSchema,
			() => ({ operations: [], instances: {}, commands: {}, requests: {} }),
			manager.entries,
		);
		manager.portableSnapshots = () =>
			Object.entries(this.state.instances)
				.filter(([id]) => manager.listServers().some((s) => s.id === id))
				.map(([id, item]) => ({ id, snapshot: item.snapshot }));
	}
	initialize() {
		return (this.initializing ??= (async () => {
			this.state = await this.store.read();
			for (const op of this.state.operations)
				if (op.status === "running") {
					op.status = "interrupted";
					op.stage = "interrupted";
					op.message =
						"Desktop restarted. Inspect or verify this instance before retrying; nothing was replayed.";
				}
			for (const server of this.manager.listServers()) {
				if (this.state.instances[server.id]) continue;
				try {
					this.state.instances[server.id] = {
						directory: "",
						custom: false,
						snapshot: await this.catalog.portableSnapshot(server.id),
					};
				} catch {
					/* Manually configured servers have no portable bundle. */
				}
			}
			await this.save();
		})());
	}
	private async save() {
		const snapshot = structuredClone(this.state);
		await this.store.mutate((s) => {
			s.operations = snapshot.operations;
			s.instances = snapshot.instances;
			s.commands = snapshot.commands;
			s.requests = snapshot.requests;
		});
		this.manager.changed();
	}
	async status(id?: string) {
		await this.initialize();
		let changed = false;
		for (const op of this.state.operations) {
			const job = this.catalog.jobs().find((j) => j.id === op.catalogJobId);
			if (job && job.kind !== "install" && job.status !== "running") {
				const status = job.status === "completed" ? "ready" : job.status;
				if (op.status !== status) {
					op.status = status;
					op.stage = job.stage;
					op.updatedAt = new Date().toISOString();
					changed = true;
					op.message =
						status === "ready"
							? "Connected. Authentication and verification passed."
							: "Setup needs attention on this device.";
				}
			}
		}
		if (changed) await this.save();
		return structuredClone(this.state.operations.filter((o) => !id || o.id === id));
	}
	async fields(id: string) {
		await this.initialize();
		const item = this.state.instances[id];
		if (!item) return [];
		if (item.snapshot.bundle.kind === "catalog")
			return (
				(await this.catalog.list()).find(
					(e) => item.snapshot.bundle.kind === "catalog" && e.id === item.snapshot.bundle.catalogId,
				)?.fields ?? []
			);
		const manifest = manifestSchema.parse(
			JSON.parse(await readFile(join(item.directory, "manifest.json"), "utf8")),
		);
		return Object.entries(manifest.user_config).map(([key, f]) => ({
			key,
			label: f.title ?? key,
			type: f.sensitive ? "password" : f.type,
			required: f.required,
			default: f.sensitive ? "" : String(f.default ?? ""),
		}));
	}
	snapshots() {
		return this.manager.portableSnapshots();
	}
	async devices() {
		if (this.manager.status().mode !== "linked") return [];
		const result = await (await this.manager.credentialRelayApi()).post("portable-inventory", {});
		return z
			.array(
				z.object({
					id: z.string().uuid(),
					name: z.string(),
					online: z.boolean(),
					connections: z.array(
						z.object({
							id: z.string().uuid(),
							name: z.string(),
							remoteEnabled: z.boolean(),
							portableReady: z.boolean(),
						}),
					),
				}),
			)
			.parse(result)
			.filter((device) => device.id !== this.manager.status().installationId);
	}
	async copy(sourceId: string, idempotencyKey: string, authorize: () => void = () => {}) {
		await this.initialize();
		authorize();
		const previous = this.state.operations.find((op) => op.idempotencyKey === idempotencyKey);
		if (previous) {
			if (this.state.requests[previous.id]?.snapshot?.copiedFrom?.connectionId !== sourceId)
				throw new Error("Idempotency key already belongs to a different request");
			return structuredClone(previous);
		}
		const snapshot = portableSnapshot.parse(
			await (await this.manager.credentialRelayApi()).post("portable-source", { sourceId }),
		);
		return this.install({ snapshot, configuration: {}, idempotencyKey }, authorize);
	}
	async artifact(sha256: string) {
		if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid artifact");
		return readFile(join(this.manager.root, "bundle-artifacts", `${sha256}.mcpb`));
	}
	async install(value: unknown, authorize: () => void = () => {}) {
		const request = installRequest.parse(value);
		const task = this.queue
			.catch(() => {})
			.then(async () => {
				await this.initialize();
				authorize();
				const fingerprint = hash(canonicalJson(request));
				const old = this.state.operations.find((o) => o.idempotencyKey === request.idempotencyKey);
				if (old) {
					if (old.fingerprint !== fingerprint)
						throw new Error("Idempotency key already belongs to a different request");
					return structuredClone(old);
				}
				const id = randomUUID(),
					connectorId = `pc_${randomUUID()}`;
				const op: PortableOperation = {
					id,
					connectorId,
					name:
						request.catalogId ??
						(request.bundleFile
							? basename(request.bundleFile)
							: request.snapshot?.bundle.kind === "custom"
								? request.snapshot.bundle.name
								: request.snapshot?.bundle.catalogId),
					idempotencyKey: request.idempotencyKey,
					fingerprint,
					status: "running",
					stage: "preparing",
					message: "Preparing connector",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					sourceId: request.snapshot?.sourceId,
				};
				this.state.operations.push(op);
				// Retry references are local and encrypted. Credentials are deliberately recollected.
				this.state.requests[id] = { ...request, configuration: {} };
				await this.save();
				const controller = new AbortController();
				this.active.set(id, controller);
				const check = () => {
					authorize();
					if (controller.signal.aborted) throw new Error("Cancelled");
				};
				void this.performInstall(op, request, check)
					.catch(async (error: unknown) => {
						op.status = controller.signal.aborted ? "cancelled" : "failed";
						op.message = safeInstallError(error);
					})
					.finally(async () => {
						this.active.delete(id);
						op.updatedAt = new Date().toISOString();
						await this.save();
						await this.manager.refresh();
					});
				return structuredClone(op);
			});
		this.queue = task;
		return task;
	}
	private async performInstall(
		op: PortableOperation,
		request: z.infer<typeof installRequest>,
		check: () => void,
	) {
		const source = request.snapshot?.bundle;
		const catalogId =
			request.catalogId ?? (source?.kind === "catalog" ? source.catalogId : undefined);
		if (catalogId) {
			const entry = bundleCatalog.find((e) => e.id === catalogId);
			// npm snapshots pin the copied version; legacy bundle snapshots follow today's catalog.
			const version = source?.kind === "catalog" ? pinnedVersion(entry, source) : undefined;
			if (!entry || (source?.kind === "catalog" && !entry.npm && source.version !== entry.version))
				throw new Error("Pinned catalog version unavailable");
			op.name = entry.name;
			// Catalog snapshots carry only workspace/provider identity; session paths are always new.
			const config = { ...request.snapshot?.configuration, ...request.configuration };
			for (const key of ["profile_dir", "session_dir", "token_file", "storage_dir"])
				delete config[key];
			const fields = (await this.catalog.list()).find((e) => e.id === catalogId)!.fields;
			this.state.instances[op.connectorId] = {
				directory: "",
				custom: false,
				snapshot: {
					version: 1,
					sourceId: op.connectorId,
					copiedFrom: request.snapshot?.copiedFrom,
					bundle: {
						kind: "catalog",
						catalogId,
						version: version ?? entry.version,
						...(entry.npm ? { package: entry.npm.package } : {}),
					},
					configuration: reusableConnectorSettings(config),
				},
			};
			if (fields.some((f) => f.required && !config[f.key] && !f.default)) {
				op.status = "needs_configuration";
				op.message = "Complete the required settings on this device.";
				return;
			}
			const job = await this.catalog.install(
				{ catalogId, serverId: op.connectorId, configuration: config, version },
				{ localOnly: true, authorize: check },
			);
			op.catalogJobId = job.id;
			await this.save();
			await this.follow(op, job.id, check);
			if (op.status === "failed" || op.status === "cancelled") return;
			this.state.instances[op.connectorId] = {
				directory: "",
				custom: false,
				snapshot: {
					...(await this.catalog.portableSnapshot(op.connectorId)),
					copiedFrom: request.snapshot?.copiedFrom,
				},
			};
			op.status = "needs_authentication";
			op.stage = "installed";
			op.message = "Installed. Complete fresh sign-in on this device, then verify.";
			return;
		}
		let bytes: Buffer;
		if (request.bundleFile) {
			if ((await stat(request.bundleFile)).size > 64 * 1024 * 1024)
				throw new Error("Bundle too large");
			bytes = await readFile(request.bundleFile);
		} else if (source?.kind === "custom") {
			const result = (await (
				await this.manager.credentialRelayApi()
			).post("portable-artifact", { sha256: source.sha256 })) as { url: string };
			const signal = this.active.get(op.id)?.signal;
			const response = await fetch(result.url, {
				redirect: "error",
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
					: AbortSignal.timeout(60_000),
			});
			if (!response.ok || Number(response.headers.get("content-length")) > 64 * 1024 * 1024)
				throw new Error("Artifact unavailable");
			const reader = response.body!.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const r = await reader.read();
					if (r.done) break;
					size += r.value.length;
					if (size > 64 * 1024 * 1024) throw new Error("Bundle too large");
					chunks.push(r.value);
				}
			} finally {
				await reader.cancel();
			}
			bytes = Buffer.concat(chunks);
			if (hash(bytes) !== source.sha256) throw new Error("Artifact checksum mismatch");
		} else throw new Error("Missing bundle");
		check();
		const sha256 = hash(bytes);
		const directory = join(this.manager.root, "instances", op.connectorId, "bundle");
		// Retrying a pre-launch failure can replace only this operation's uninstalled directory.
		if (!this.manager.listServers().some((server) => server.id === op.connectorId))
			await rm(directory, { recursive: true, force: true });
		await extractBundle(bytes, directory, this.active.get(op.id)?.signal);
		const manifest = manifestSchema.parse(
			JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
		);
		if (
			manifest.compatibility?.platforms &&
			!manifest.compatibility.platforms.includes(process.platform as "win32" | "darwin" | "linux")
		)
			throw new Error("Unsupported platform");
		const range = manifest.compatibility?.runtimes?.node;
		if (
			manifest.server.type === "node" &&
			range &&
			(!validRange(range) || !satisfies(process.versions.node, range))
		)
			throw new Error("Unsupported Node runtime");
		const python = manifest.compatibility?.runtimes?.python;
		if (manifest.server.type === "python" && python && !/^>=?\s*3\.\d+(?:\.\d+)?$/.test(python))
			throw new Error("Unsupported Python runtime");
		op.name = manifest.name;
		const artifact = join(this.manager.root, "bundle-artifacts", `${sha256}.mcpb`);
		await mkdir(dirname(artifact), { recursive: true, mode: 0o700 });
		await writeFile(artifact, bytes, { mode: 0o600 });
		this.state.instances[op.connectorId] = {
			directory,
			artifact,
			custom: true,
			snapshot: {
				version: 1,
				sourceId: op.connectorId,
				copiedFrom: request.snapshot?.copiedFrom,
				platforms: manifest.compatibility?.platforms,
				bundle: { kind: "custom", sha256, name: manifest.name, version: manifest.version },
				configuration: {},
			},
		};
		await this.configureCustom(op.connectorId, request.configuration, check);
		const installed = this.manager.listServers().some((s) => s.id === op.connectorId);
		op.status = installed ? "needs_authentication" : "needs_configuration";
		op.stage = op.status;
		op.message = installed
			? "Installed. Supply credentials on this device if required, then verify."
			: "Required settings must be supplied on this device.";
	}
	private async configureCustom(id: string, values: Record<string, string>, check: () => void) {
		const item = this.state.instances[id];
		if (!item?.custom) throw new Error("Not a custom bundle");
		const manifest = manifestSchema.parse(
			JSON.parse(await readFile(join(item.directory, "manifest.json"), "utf8")),
		);
		const configuration: Record<string, string> = {};
		for (const [key, field] of Object.entries(manifest.user_config)) {
			const value = values[key] ?? (field.sensitive ? undefined : field.default);
			if ((value === undefined || value === "") && field.required) return;
			if (value !== undefined) {
				if (field.type === "number" && !Number.isFinite(Number(value)))
					throw new Error("Invalid required setting");
				if (
					field.type === "number" &&
					((field.min !== undefined && Number(value) < field.min) ||
						(field.max !== undefined && Number(value) > field.max))
				)
					throw new Error("Invalid required setting");
				if (field.type === "boolean" && !["true", "false"].includes(String(value)))
					throw new Error("Invalid required setting");
				configuration[key] = String(value);
			}
		}
		const home = join(this.manager.root, "instances", id, "home");
		await mkdir(home, { recursive: true, mode: 0o700 });
		const replace = (text: string) => {
			const result = text
				.replaceAll("${__dirname}", item.directory)
				.replaceAll("${HOME}", home)
				.replaceAll("${pathSeparator}", sep)
				.replaceAll("${/}", sep)
				.replace(/\$\{user_config\.([\w-]+)\}/g, (_, key) => {
					if (!(key in configuration)) throw new Error("Missing setting");
					return configuration[key]!;
				});
			if (result.includes("${")) throw new Error("Unsupported placeholder");
			return result;
		};
		const base = manifest.server.mcp_config;
		const override = base.platform_overrides?.[process.platform as "win32" | "darwin" | "linux"];
		const launch = { ...base, ...override, env: { ...base.env, ...override?.env } };
		let command = replace(launch.command),
			args = launch.args.map(replace);
		if (manifest.server.type === "node" && command === "node") command = this.nodePath;
		else if (manifest.server.type === "python" && ["python", "python3"].includes(command)) {
			command = join(
				this.manager.resources,
				"runtimes",
				process.platform === "win32" ? "uv.exe" : "uv",
			);
			args = [
				"run",
				...(manifest.compatibility?.runtimes?.python
					? ["--python", manifest.compatibility.runtimes.python]
					: []),
				"--project",
				item.directory,
				"python",
				...args,
			];
		} else {
			command = resolve(item.directory, command);
			if (
				manifest.server.type === "binary" &&
				process.platform === "win32" &&
				!command.toLowerCase().endsWith(".exe")
			)
				command += ".exe";
			if (!command.startsWith(resolve(item.directory) + sep))
				throw new Error("Bundle command must be inside the bundle");
		}
		check();
		const config = serverConfig.parse({
			id,
			name: manifest.name,
			transport: "stdio",
			enabled: false,
			command,
			args,
			cwd: item.directory,
			env: {
				...Object.fromEntries(Object.entries(launch.env).map(([k, v]) => [k, replace(v)])),
				HOME: home,
				USERPROFILE: home,
				APPDATA: join(home, "AppData", "Roaming"),
				LOCALAPPDATA: join(home, "AppData", "Local"),
				XDG_CONFIG_HOME: join(home, ".config"),
				XDG_DATA_HOME: join(home, ".local", "share"),
				XDG_CACHE_HOME: join(home, ".cache"),
				XDG_STATE_HOME: join(home, ".local", "state"),
			},
		});
		if (this.manager.listServers().some((s) => s.id === id))
			await this.manager.updateServer(id, config);
		else await this.manager.addServers([config], false, { authorize: check, localOnly: true });
	}
	private async follow(op: PortableOperation, jobId: string, check: () => void) {
		while (true) {
			try {
				check();
			} catch (error) {
				try {
					this.catalog.cancel(jobId);
				} catch {}
				throw error;
			}
			const job = this.catalog.jobs().find((j) => j.id === jobId);
			if (!job) throw new Error("Job interrupted");
			op.stage = job.stage;
			if (job.status !== "running") {
				if (job.status !== "completed") op.status = job.status;
				return;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	async cancel(id: string) {
		await this.initialize();
		const op = this.state.operations.find((o) => o.id === id);
		if (!op) throw new Error("Unknown operation");
		this.active.get(id)?.abort();
		if (op.catalogJobId) {
			try {
				this.catalog.cancel(op.catalogJobId);
			} catch {}
		}
		return { cancelled: true };
	}
	async manage(value: unknown, authorize: () => void = () => {}) {
		const parsed = localManagementRequest.parse(value);
		if ("action" in parsed && parsed.action === "copy")
			return this.copy(parsed.sourceId, parsed.idempotencyKey, authorize);
		if (!("command" in parsed)) return this.performCommand(parsed, authorize);
		const key = hash(`local:${parsed.idempotencyKey}`);
		const operationId = `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
		const receipt = await this.journaled(operationId, parsed.command, authorize);
		return { operationId, ...receipt };
	}
	private async performCommand(value: unknown, authorize: () => void) {
		const command = managementCommand.parse(value);
		await this.initialize();
		authorize();
		if (command.action === "cancel") return this.cancel(command.id);
		if (command.action === "retry") {
			const op = this.state.operations.find((o) => o.id === command.id),
				request = this.state.requests[command.id];
			if (!op || !request) throw new Error("Unknown operation");
			if (!["failed", "cancelled", "interrupted"].includes(op.status)) return structuredClone(op);
			// Reconcile an interrupted commit before doing any installation work.
			if (this.manager.listServers().some((server) => server.id === op.connectorId)) {
				op.status = "needs_authentication";
				op.message = "The connector is installed. Complete sign-in or verify on this device.";
				await this.save();
				return structuredClone(op);
			}
			op.status = "running";
			op.catalogJobId = undefined;
			op.stage = "preparing";
			await this.save();
			const controller = new AbortController();
			this.active.set(op.id, controller);
			const check = () => {
				authorize();
				if (controller.signal.aborted) throw new Error("Cancelled");
			};
			void this.performInstall(op, request, check)
				.catch((error: unknown) => {
					op.status = controller.signal.aborted ? "cancelled" : "failed";
					op.message = safeInstallError(error);
				})
				.finally(async () => {
					this.active.delete(op.id);
					await this.save();
					await this.manager.refresh();
				});
			return structuredClone(op);
		}
		if (command.action === "install") return this.install(command.request, authorize);
		if (command.action === "bulk")
			return Promise.all(
				command.requests.map(async (request) => {
					try {
						return await this.install(request, authorize);
					} catch {
						return {
							idempotencyKey: request.idempotencyKey,
							status: "failed",
							message: "Request could not be accepted",
						};
					}
				}),
			);
		if (command.action === "access") return this.manager.setAccess(command.id, command.access);
		if (command.action === "remove") {
			await this.manager.removeServer(command.id);
			delete this.state.instances[command.id];
			await this.save();
			return { removed: true };
		}
		if (command.action === "configure") {
			const item = this.state.instances[command.id];
			if (!item) throw new Error("Unknown bundle instance");
			if (item.custom) {
				await this.configureCustom(command.id, command.configuration, authorize);
				const op = this.state.operations.find((o) => o.connectorId === command.id);
				if (op && this.manager.listServers().some((server) => server.id === command.id)) {
					op.status = "needs_authentication";
					op.message = "Settings saved. Complete sign-in if required, then verify.";
				}
			} else if (item.snapshot.bundle.kind === "catalog") {
				const catalogBundle = item.snapshot.bundle;
				if (this.manager.listServers().some((server) => server.id === command.id)) {
					await this.catalog.configure(command.id, command.configuration, authorize);
					item.snapshot = {
						...(await this.catalog.portableSnapshot(command.id)),
						copiedFrom: item.snapshot.copiedFrom,
					};
					const op = this.state.operations.find((o) => o.connectorId === command.id);
					if (op) {
						op.status = "needs_authentication";
						op.catalogJobId = undefined;
						op.message = "Settings changed. Complete sign-in and verify on this device.";
					}
					await this.save();
					return { configured: true };
				}
				const op = this.state.operations.find((o) => o.connectorId === command.id)!;
				const job = await this.catalog.install(
					{
						catalogId: item.snapshot.bundle.catalogId,
						serverId: command.id,
						configuration: { ...item.snapshot.configuration, ...command.configuration },
						version: pinnedVersion(
							bundleCatalog.find((e) => e.id === catalogBundle.catalogId),
							catalogBundle,
						),
					},
					{ authorize, localOnly: true },
				);
				op.status = "running";
				op.catalogJobId = job.id;
				void this.follow(op, job.id, authorize)
					.then(async () => {
						if (op.status === "running") {
							item.snapshot = {
								...(await this.catalog.portableSnapshot(command.id)),
								copiedFrom: item.snapshot.copiedFrom,
							};
							op.status = "needs_authentication";
						}
					})
					.catch(() => {
						op.status = "failed";
					})
					.finally(() => this.save());
			}
			await this.save();
			return { configured: this.manager.listServers().some((s) => s.id === command.id) };
		}
		const item = this.state.instances[command.id];
		if (command.action === "repair" && item?.custom) {
			const bundle = item.snapshot.bundle;
			if (bundle.kind !== "custom") throw new Error("Bundle identity mismatch");
			const bytes = await this.artifact(bundle.sha256);
			if (hash(bytes) !== bundle.sha256) throw new Error("Artifact checksum mismatch");
			const staging = `${item.directory}.repair-${randomUUID()}`,
				backup = `${item.directory}.backup-${randomUUID()}`;
			let moved = false;
			try {
				await extractBundle(bytes, staging);
				authorize();
				await this.manager.setEnabled(command.id, false);
				authorize();
				await rename(item.directory, backup);
				moved = true;
				try {
					await rename(staging, item.directory);
				} catch (error) {
					await rename(backup, item.directory);
					moved = false;
					throw error;
				}
			} finally {
				await rm(staging, { recursive: true, force: true });
				if (moved) await rm(backup, { recursive: true, force: true });
			}
			await this.manager.restartServer(command.id);
			return { repaired: true };
		}
		if (!item?.custom) {
			const job = await (command.action === "authenticate"
				? this.catalog.authenticate(command.id, authorize)
				: command.action === "repair"
					? this.catalog.repair(command.id, authorize)
					: this.catalog.verify(command.id, authorize));
			const op = this.state.operations.find((o) => o.connectorId === command.id);
			if (op) {
				op.catalogJobId = job.id;
				op.status = "running";
				await this.save();
			}
			return job;
		}
		if (command.action === "authenticate")
			return {
				needsUserAction: true,
				message:
					"Enter required credentials in this connector's settings on the target Desktop, then Verify. This bundle has no automatic sign-in adapter.",
			};
		await this.manager.setEnabled(command.id, true);
		const server = this.manager.listServers().find((s) => s.id === command.id);
		const op = this.state.operations.find((o) => o.connectorId === command.id);
		if (op && server?.status === "online") {
			op.status = "ready";
			op.stage = "verified";
			op.message =
				"MCP connection verified. Provider access follows this bundle's authentication requirements.";
			await this.save();
		}
		return {
			verified: server?.status === "online",
			message:
				"MCP connection verified; provider authentication must be completed using the bundle's instructions.",
		};
	}
	async remoteManage(operationId: string, command: unknown) {
		return this.journaled(
			operationId,
			command,
			() => {
				if (!this.remoteAllowed.has(operationId) || this.manager.status().mode !== "linked")
					throw new Error("Management authorization unavailable");
			},
			true,
		);
	}
	private async journaled(
		operationId: string,
		command: unknown,
		authorize: () => void,
		remote = false,
	) {
		await this.initialize();
		if (remote) this.remoteAllowed.add(operationId);
		authorize();
		const fingerprint = hash(canonicalJson(command)),
			old = this.state.commands[operationId];
		if (old) {
			if (old.fingerprint !== fingerprint) throw new Error("Operation changed");
			return old.receipt;
		}
		const row = {
			fingerprint,
			receipt: { status: "interrupted" } as Record<string, unknown>,
			catalogJobId: undefined as string | undefined,
		};
		this.state.commands[operationId] = row;
		await this.save();
		this.commanding.add(operationId);
		let result: unknown;
		try {
			result = await this.performCommand(command, authorize);
		} finally {
			this.commanding.delete(operationId);
		}
		const values = Array.isArray(result) ? result : [result];
		const safe = values.map((v) =>
			v && typeof v === "object"
				? Object.fromEntries(
						Object.entries(v).filter(([k]) =>
							[
								"id",
								"connectorId",
								"status",
								"stage",
								"verified",
								"needsUserAction",
								"removed",
								"configured",
								"repaired",
								"cancelled",
							].includes(k),
						),
					)
				: {},
		);
		row.receipt = {
			status: safe.some((v) => "id" in v) ? "accepted" : "completed",
			items: safe,
		};
		if (
			result &&
			typeof result === "object" &&
			"id" in result &&
			typeof result.id === "string" &&
			this.catalog.jobs().some((j) => j.id === result.id)
		)
			row.catalogJobId = result.id;
		await this.save();
		return row.receipt;
	}
	async remoteStatus(operationId: string) {
		await this.status();
		const row = this.state.commands[operationId];
		if (!row) return { status: "unavailable" };
		if (this.commanding.has(operationId)) return { status: "running" };
		if (row.catalogJobId) {
			const job = this.catalog.jobs().find((j) => j.id === row.catalogJobId);
			return job ? { status: job.status, stage: job.stage } : { status: "interrupted" };
		}
		const items = row.receipt.items;
		if (Array.isArray(items))
			return {
				status: row.receipt.status,
				items: items.map((item) => this.state.operations.find((o) => o.id === item.id) ?? item),
			};
		return row.receipt;
	}
	async revalidateRemote() {
		for (const [id, command] of Object.entries(this.state.commands)) {
			if (!this.remoteAllowed.has(id)) continue;
			const pending = command.catalogJobId
				? this.catalog.jobs().some((j) => j.id === command.catalogJobId && j.status === "running")
				: Array.isArray(command.receipt.items) &&
					command.receipt.items.some((item) => this.active.has(item.id));
			if (!pending && !this.commanding.has(id)) {
				this.remoteAllowed.delete(id);
				continue;
			}
			try {
				await (
					await this.manager.credentialRelayApi()
				).post("portable-authorize", { operationId: id });
			} catch {
				this.cancelRemote(id);
			}
		}
	}
	cancelRemote(id?: string) {
		for (const operationId of id ? [id] : [...this.remoteAllowed]) {
			this.remoteAllowed.delete(operationId);
			const command = this.state.commands[operationId];
			if (!command) continue;
			if (command.catalogJobId) {
				try {
					this.catalog.cancel(command.catalogJobId);
				} catch {}
			}
			const items = command.receipt.items;
			if (Array.isArray(items))
				for (const item of items)
					if (typeof item.id === "string") this.active.get(item.id)?.abort();
		}
	}
}

function safeInstallError(error: unknown) {
	if (error instanceof z.ZodError)
		return "Unsupported or malformed MCPB manifest. Check manifest_version, server runtime, and scalar user_config fields.";
	const message = error instanceof Error ? error.message : "";
	const errors: Record<string, string> = {
		"Unsupported Node runtime":
			"This bundle requires a different Node version. Install a compatible Desktop release or bundle.",
		"Unsupported Python runtime":
			"This Python runtime constraint is unsupported. Use a minimum Python 3 version in the MCPB manifest.",
		"Unsupported platform":
			"This bundle does not support this operating system. Select a compatible MCPB bundle.",
		"Pinned catalog version unavailable":
			"The pinned catalog version is unavailable in this Desktop release. Install a Desktop version that supports it.",
		"Artifact checksum mismatch":
			"Bundle integrity verification failed. Obtain the original matching bundle before retrying.",
		"Artifact unavailable":
			"The synced bundle is unavailable. Reconnect the source device to finish uploading it.",
		"Bundle too large": "MCPB bundles must be no larger than 64 MiB.",
		"Invalid required setting":
			"A number or boolean setting is invalid. Correct the required settings and try again.",
		"Unsupported placeholder": "This MCPB launch configuration uses an unsupported placeholder.",
		"Bundle command must be inside the bundle":
			"The executable must be bundled or use the supported Node or Python runtime.",
		Cancelled: "Installation cancelled. Successful connectors were preserved.",
	};
	return (
		errors[message] ??
		"Setup did not complete. Check bundle integrity, compatibility, and required settings; existing instances were preserved."
	);
}
