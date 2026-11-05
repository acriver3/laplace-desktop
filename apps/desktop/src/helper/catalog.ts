import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, open, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, isAbsolute, dirname, delimiter, sep, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { browserProviders } from "@repo/browser-runtime/browser-approval";
import {
	sessionRecoveryEnabled,
	recoveryFromResult,
	classifyRecovery,
	recoveryMessage,
	RecoveryError,
	recoveryDelay,
	type RecoveryStatus,
} from "@repo/browser-runtime/session-recovery";
import { browserConfiguration } from "@repo/local-mcp-core/browser-catalog";
import {
	prepareBrowserMigration,
	type BrowserMigration,
} from "@repo/local-mcp-core/browser-migration";
import { serverConfig, minimalEnvironment, type ServerConfig } from "@repo/local-mcp-core/config";
import { acquireResourceLeases } from "@repo/local-mcp-core/leases";
import { spawnLocal, stopTree } from "@repo/local-mcp-core/process";
import { reusableConnectorSettings } from "@repo/project-protocol/portable-connectors";
import {
	setupNotificationOwner,
	type SetupNotificationOwner,
} from "@repo/project-protocol/setup-notifications";
import { fromBuffer, type ZipFile, type Entry } from "yauzl";

import { slackBrowserVersion } from "../shared/slack-browser";
import { ycWorkspace } from "../shared/yc-browser";
import type { BrowserApprovals } from "./browser-approvals";
import {
	bundleCatalog,
	allBundleCatalog,
	tetheredEntry,
	bundleAvailable,
	type BundleCatalogEntry,
	type BundleArtifact,
} from "./library-catalog";
import { slackBrowserConfig } from "./slack-browser-config";
import { ycBrowserConfig } from "./yc-browser-config";
const browserSlack = (entry: BundleCatalogEntry) =>
	entry.recipe === "slack-ready" && entry.version === slackBrowserVersion;
const browserEntry = (entry: BundleCatalogEntry) =>
	tetheredEntry(entry) || browserSlack(entry) || entry.recipe === "yc-demo";
const browserConfig = async (
	entry: BundleCatalogEntry,
	configuration: Record<string, string>,
	resources: string,
	nodePath: string,
) =>
	tetheredEntry(entry)
		? {
				...(await browserConfiguration(resources, entry.id, configuration.workspace)),
				enabled: false,
			}
		: entry.recipe === "yc-demo"
			? ycBrowserConfig(resources, nodePath)
			: slackBrowserConfig(configuration.workspace!, resources, nodePath);

interface CatalogManager {
	addServers(
		configs: ServerConfig[],
		migrated?: boolean,
		options?: { authorize?: () => void; localOnly?: boolean },
	): Promise<unknown>;
	browserMigrationRecords?(): Promise<BrowserMigration[]>;
	prepareBrowserMigration?(record: BrowserMigration): Promise<void>;
	completeBrowserMigration?(id: string): Promise<void>;
	rollbackBrowserMigration?(id: string): Promise<void>;
	getServerConfig(id: string): ServerConfig;
	setEnabled(id: string, enabled: boolean): Promise<unknown>;
	restartServer(id: string): Promise<unknown>;
	updateServer?(id: string, config: ServerConfig): Promise<unknown>;
	catalogSetupCall(
		id: string,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface CatalogJob {
	recovery?: RecoveryStatus;
	connectorName?: string;
	notificationOwner?: SetupNotificationOwner;
	notificationDelivered?: boolean;
	id: string;
	catalogId: string;
	serverId: string;
	kind: "install" | "authenticate" | "verify";
	status: "running" | "completed" | "failed" | "cancelled";
	stage: string;
	message: string;
	progress?: number;
	error?: string;
	startedAt: string;
	finishedAt?: string;
	browserApproval?: {
		requestId: string;
		workspace: string;
		expiresAt: string;
		extensionDirectory: string;
	};
}
interface Installation {
	catalogId: string;
	version: string;
	serverId: string;
	directory: string;
	configuration: Record<string, string>;
}
interface CatalogOptions {
	notificationOwner?: () => SetupNotificationOwner | undefined;
	browserApprovals?: BrowserApprovals;
	root: string;
	resources: string;
	nodePath: string;
	origin?: string;
	onChange?: () => void;
	fetch?: typeof fetch;
}
const serverIds: Record<string, string> = {
	"ycombinator-demo": "ycombinator-demo",
	"canvas-session-mcp": "canvas-session",
	"linkedin-mcp-server": "linkedin",
	"yale-som-ems-mcp": "yale-som-ems",
	"msoutlook-mcp": "outlook",
	"slack-mcp-server": "slack",
};
const checks: Record<string, string[]> = {
	"yc-demo": ["list_applications"],
	canvas: ["canvas_whoami", "canvas_list_courses"],
	linkedin: ["get_my_profile"],
	"yale-som-ems": ["ems_session_status", "ems_list_templates"],
	outlook: ["outlook_status", "outlook_list_folders"],
	"slack-ready": ["channels_list"],
};
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 20000;
const abortError = () => new Error("Operation cancelled.");
const assertActive = (signal?: AbortSignal) => {
	if (signal?.aborted) throw abortError();
};

export function safeArchivePath(name: string) {
	if (
		!name ||
		name.includes("\\") ||
		name.includes(":") ||
		name.split("").some((character) => character.charCodeAt(0) < 32) ||
		name.startsWith("/")
	)
		throw new Error("Archive contains an unsafe path.");
	const parts = name.replace(/\/$/, "").split("/");
	if (
		parts.some(
			(part) =>
				!part ||
				part === "." ||
				part === ".." ||
				/[ .]$/.test(part) ||
				/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
		)
	)
		throw new Error("Archive contains an unsafe path.");
	return parts.join("/");
}

/** Safe bounded extraction; callers verify archive identity before invoking it. */
export async function extractBundle(bytes: Buffer, destination: string, signal?: AbortSignal) {
	await mkdir(destination, { recursive: true, mode: 0o700 });
	assertActive(signal);
	const zip = await new Promise<ZipFile>((accept, reject) =>
		fromBuffer(
			bytes,
			{ lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true },
			(error, value) =>
				error || !value ? reject(error ?? new Error("Invalid archive.")) : accept(value),
		),
	);
	const seen = new Set<string>();
	let count = 0,
		expanded = 0;
	await new Promise<void>((accept, reject) => {
		let settled = false;
		const fail = (error: unknown) => {
			if (!settled) {
				settled = true;
				zip.close();
				reject(error);
			}
		};
		const aborted = () => fail(abortError());
		signal?.addEventListener("abort", aborted, { once: true });
		zip.once("error", fail);
		zip.once("end", () => {
			if (!settled) {
				settled = true;
				signal?.removeEventListener("abort", aborted);
				accept();
			}
		});
		zip.on("entry", (entry: Entry) => {
			void (async () => {
				assertActive(signal);
				const name = safeArchivePath(entry.fileName);
				const identity = name.normalize("NFC").toLowerCase();
				const mode = entry.externalFileAttributes >>> 16;
				const kind = mode & 0o170000;
				if (
					seen.has(identity) ||
					++count > MAX_ARCHIVE_FILES ||
					(kind !== 0 && kind !== 0o100000 && kind !== 0o040000) ||
					entry.generalPurposeBitFlag & 1
				)
					throw new Error("Archive contains duplicate, encrypted, linked, or unsupported files.");
				seen.add(identity);
				if (
					!Number.isSafeInteger(entry.uncompressedSize) ||
					entry.uncompressedSize < 0 ||
					(expanded += entry.uncompressedSize) > MAX_EXPANDED_BYTES
				)
					throw new Error("Archive exceeds the expanded size limit.");
				const target = join(destination, name);
				if (entry.fileName.endsWith("/")) {
					await mkdir(target, { recursive: true, mode: 0o700 });
					zip.readEntry();
					return;
				}
				if (kind === 0o040000) throw new Error("Archive directory has an invalid filename.");
				await mkdir(dirname(target), { recursive: true, mode: 0o700 });
				const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
					zip.openReadStream(entry, (error, value) =>
						error || !value ? rej(error ?? new Error("Missing archive entry.")) : res(value),
					),
				);
				const file = await open(target, "wx", mode & 0o111 ? 0o755 : 0o600);
				let written = 0;
				try {
					for await (const chunk of stream) {
						assertActive(signal);
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						written += buffer.length;
						if (written > entry.uncompressedSize)
							throw new Error("Archive entry exceeds its declared size.");
						await file.writeFile(buffer);
					}
					if (written !== entry.uncompressedSize) throw new Error("Archive entry is truncated.");
				} finally {
					await file.close();
				}
				zip.readEntry();
			})().catch(fail);
		});
		zip.readEntry();
	}).finally(() => zip.close());
}

export async function downloadBundle(
	url: string,
	artifact: Pick<BundleArtifact, "sha256" | "size">,
	signal: AbortSignal,
	fetcher: typeof fetch = fetch,
	progress: (fraction: number) => void = () => {},
) {
	const response = await fetcher(url, {
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
	});
	if (response.status !== 200 || !response.body)
		throw new Error(
			"The pinned bundle is unavailable. Retry later; no replacement version was installed.",
		);
	const length = response.headers.get("Content-Length");
	if (length !== null && Number(length) !== artifact.size) {
		await response.body.cancel();
		throw new Error("Bundle size does not match the catalog.");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		while (true) {
			assertActive(signal);
			const { done, value } = await reader.read();
			if (done) break;
			if ((received += value.length) > artifact.size)
				throw new Error("Bundle exceeds its catalog size.");
			chunks.push(value);
			progress(received / artifact.size);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const bytes = Buffer.concat(chunks);
	if (
		received !== artifact.size ||
		createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
	)
		throw new Error("Bundle checksum or size does not match the catalog. Nothing was installed.");
	return bytes;
}

function inputFields(entry: BundleCatalogEntry, root: string) {
	if (entry.recipe === "yc-demo" || (tetheredEntry(entry) && entry.recipe !== "slack-ready"))
		return [];
	const session = join(root, "sessions", serverIds[entry.id]!);
	if (entry.recipe === "canvas")
		return [
			{
				key: "canvas_url",
				label: "Canvas institution URL",
				type: "url",
				required: true,
				default: "",
			},
			{
				key: "downloads_dir",
				label: "Course download folder",
				type: "directory",
				required: true,
				default: join(homedir(), "Documents", "Canvas"),
			},
			{
				key: "session_dir",
				label: "Dedicated session folder",
				type: "directory",
				required: true,
				default: session,
			},
			{
				key: "browser",
				label: "Browser",
				type: "select",
				options: ["chrome", "msedge"],
				default: "chrome",
			},
		];
	if (browserSlack(entry) || (tetheredEntry(entry) && entry.recipe === "slack-ready"))
		return [
			{ key: "workspace", label: "Slack workspace URL", type: "url", required: true, default: "" },
		];
	if (entry.recipe === "slack-ready")
		return [
			{ key: "workspace", label: "Slack workspace URL", type: "url", required: true, default: "" },
			{
				key: "profile_dir",
				label: "Dedicated browser profile",
				type: "directory",
				required: true,
				default: join(session, "profile"),
			},
		];
	if (entry.recipe === "linkedin")
		return [
			{
				key: "profile_dir",
				label: "Dedicated browser profile",
				type: "directory",
				required: true,
				default: join(session, "profile"),
			},
		];
	if (entry.recipe === "yale-som-ems")
		return [
			{
				key: "profile_dir",
				label: "Dedicated browser profile",
				type: "directory",
				required: true,
				default: join(session, "profile"),
			},
			{
				key: "browser",
				label: "Browser",
				type: "select",
				options: ["chrome", "msedge"],
				default: "chrome",
			},
		];
	return [
		{
			key: "browser",
			label: "Browser",
			type: "select",
			options: ["", "chrome", "msedge"],
			default: "",
		},
	];
}

export function catalogConfiguration(
	entry: BundleCatalogEntry,
	values: Record<string, string>,
	root: string,
	directory: string,
) {
	const fields = inputFields(entry, root);
	if (Object.keys(values).some((key) => !fields.some((field) => field.key === key)))
		throw new Error("Unsupported catalog configuration field.");
	const configuration: Record<string, string> = {};
	for (const field of fields) {
		const value = values[field.key] ?? field.default;
		if (typeof value !== "string" || value.length > 4096 || value.includes("\0"))
			throw new Error(`Invalid ${field.label}.`);
		const normalized = process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
		const bundleRoot =
			process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory);
		if (
			field.type === "directory" &&
			(!isAbsolute(value) || normalized === bundleRoot || normalized.startsWith(bundleRoot + sep))
		)
			throw new Error(`${field.label} must be an absolute folder outside the installed bundle.`);
		if (field.type === "select" && !field.options?.includes(value))
			throw new Error("Choose Chrome or Edge.");
		if (field.type === "url") {
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				throw new Error(
					`Enter your ${entry.recipe === "slack-ready" ? "Slack workspace" : "Canvas institution"} HTTPS URL.`,
				);
			}
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				!["", "/"].includes(url.pathname)
			)
				throw new Error("Use an HTTPS origin without credentials, a path, or query parameters.");
			if (
				entry.recipe === "slack-ready" &&
				(url.port ||
					!/^[a-z0-9-]+\.(slack\.com|slack-gov\.com)$/.test(url.hostname) ||
					/^(app|api|edgeapi)\./.test(url.hostname))
			)
				throw new Error("Enter a Slack workspace URL such as https://your-team.slack.com.");
			configuration[field.key] = url.origin;
			continue;
		}
		configuration[field.key] = value;
	}
	return configuration;
}

export function resolveManifestConfiguration(
	manifest: unknown,
	entry: BundleCatalogEntry,
	directory: string,
	configuration: Record<string, string>,
): ServerConfig {
	const value = manifest as {
		name?: string;
		version?: string;
		server?: { mcp_config?: { command?: unknown; args?: unknown; env?: unknown } };
	};
	if (value?.name !== entry.id || value.version !== entry.version || !value.server?.mcp_config)
		throw new Error("Bundle manifest identity does not match the catalog.");
	const replace = (raw: unknown) => {
		if (typeof raw !== "string") throw new Error("Unsupported manifest value.");
		const result = raw
			.replaceAll("${__dirname}", directory)
			.replace(/\$\{user_config\.([a-z_]+)\}/g, (_match, key: string) => {
				if (!Object.hasOwn(configuration, key)) throw new Error("Unresolved manifest setting.");
				return configuration[key]!;
			});
		if (result.includes("${")) throw new Error("Unsupported manifest placeholder.");
		return result;
	};
	const launch = value.server.mcp_config;
	if (entry.recipe === "slack-ready") {
		return serverConfig.parse({
			id: "slack",
			name: entry.name,
			transport: "stdio",
			enabled: false,
			command: join(directory, "runtime", process.platform === "win32" ? "node.exe" : "node"),
			args: [
				join(directory, "browser/cli.mjs"),
				"serve",
				"--workspace",
				configuration.workspace!,
				"--profile-dir",
				configuration.profile_dir!,
			],
			env: {
				SLACK_MCP_ENABLED_TOOLS:
					"channels_list,conversations_history,conversations_replies,conversations_search_messages",
			},
			cwd: directory,
			identity: `${entry.id}@${entry.version}`,
		});
	}
	if (!Array.isArray(launch.args) || !["node", "uv"].includes(String(launch.command)))
		throw new Error("Unsupported catalog runtime.");
	const environment = launch.env === undefined ? {} : launch.env;
	if (!environment || typeof environment !== "object" || Array.isArray(environment))
		throw new Error("Unsupported manifest environment.");
	return serverConfig.parse({
		id: serverIds[entry.id],
		name: entry.name,
		transport: "stdio",
		enabled: false,
		command: launch.command,
		args: launch.args.map(replace),
		env: Object.fromEntries(Object.entries(environment).map(([key, val]) => [key, replace(val)])),
		cwd: directory,
		identity: `${entry.id}@${entry.version}`,
	});
}

export class CatalogInstaller {
	private readonly work = new Map<string, CatalogJob>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly installations = new Map<string, Installation>();
	private initialized = false;
	private saveQueue: Promise<void> = Promise.resolve();
	private jobSaveQueue: Promise<void> = Promise.resolve();
	constructor(
		private readonly manager: CatalogManager,
		private readonly options: CatalogOptions,
	) {}
	private async initialize() {
		if (this.initialized) return;
		try {
			const saved: unknown = JSON.parse(
				await readFile(join(this.options.root, "catalog-installs.json"), "utf8"),
			);
			if (Array.isArray(saved))
				for (const item of saved) {
					const entry = allBundleCatalog.find(
						(entry) => entry.id === item?.catalogId && entry.version === item.version,
					);
					if (
						entry &&
						/^[A-Za-z0-9_-]{1,80}$/.test(item.serverId) &&
						item.directory ===
							join(
								this.options.root,
								"connectors",
								item.serverId === serverIds[entry.id] ? entry.id : item.serverId,
								entry.version,
							)
					) {
						const configuration = catalogConfiguration(
							entry,
							item.configuration,
							item.serverId.startsWith("pc_")
								? join(this.options.root, "instances", item.serverId)
								: this.options.root,
							item.directory,
						);
						this.installations.set(item.serverId, { ...item, configuration });
					}
				}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error(
					"Catalog installation metadata is unreadable. Existing imported connections were preserved.",
				);
		}
		for (const record of (await this.manager.browserMigrationRecords?.()) ?? []) {
			if (record.state !== "complete") continue;
			const active = this.manager.getServerConfig(record.serverId);
			if (
				active.identity === record.candidate.identity &&
				active.managedBrowser?.artifactSha256 === record.candidate.managedBrowser?.artifactSha256
			)
				this.recordMigratedInstallation(record);
		}
		try {
			const jobs = JSON.parse(await readFile(join(this.options.root, "catalog-jobs.json"), "utf8"));
			if (Array.isArray(jobs))
				for (const job of jobs) {
					if (typeof job?.id !== "string" || typeof job?.serverId !== "string") continue;
					if (job.status === "running") {
						job.status = "failed";
						job.stage = "interrupted";
						job.finishedAt = new Date().toISOString();
						job.message =
							"Desktop restarted. Inspect the connector before retrying; no operation was replayed.";
					}
					this.work.set(job.id, job);
				}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("Setup journal unreadable");
		}
		this.initialized = true;
	}
	private saveJobs() {
		const values = [...this.work.values()].map(({ error: _, ...job }) => ({
			...job,
			message: job.status === "failed" ? "Setup failed. Inspect Desktop diagnostics." : job.message,
		}));
		const task = this.jobSaveQueue
			.catch(() => {})
			.then(async () => {
				await mkdir(this.options.root, { recursive: true, mode: 0o700 });
				const file = join(this.options.root, `catalog-jobs.${randomUUID()}.tmp`);
				try {
					await writeFile(file, JSON.stringify(values), { mode: 0o600, flag: "wx" });
					await rename(file, join(this.options.root, "catalog-jobs.json"));
				} finally {
					await rm(file, { force: true });
				}
			});
		this.jobSaveQueue = task;
		return task;
	}

	private save() {
		const task = this.saveQueue
			.catch(() => {})
			.then(async () => {
				await mkdir(this.options.root, { recursive: true, mode: 0o700 });
				const temporary = join(this.options.root, `catalog-installs.${randomUUID()}.tmp`);
				try {
					await writeFile(temporary, JSON.stringify([...this.installations.values()]), {
						mode: 0o600,
						flag: "wx",
					});
					await rename(temporary, join(this.options.root, "catalog-installs.json"));
				} finally {
					await rm(temporary, { force: true });
				}
			});
		this.saveQueue = task;
		return task;
	}
	async list() {
		await this.initialize();
		return [
			...bundleCatalog.map((entry) => ({
				id: entry.id,
				name: entry.name,
				setupUrl: entry.setupUrl,
				browserMode: entry.browserMode,
				description: entry.description,
				version: entry.version,
				demoOnly: entry.demoOnly === true,
				repository: entry.repository,
				available:
					browserEntry(entry) ||
					entry.artifacts.some(
						(artifact) =>
							bundleAvailable(artifact) &&
							artifact.platforms.includes(`${process.platform}-${process.arch}` as never),
					),
				serverId: this.attachedId(entry) ?? serverIds[entry.id],
				installed: this.isAttached(entry),
				installedVersion: this.installations.get(this.attachedId(entry) ?? "")?.version,
				installedBrowserMode: allBundleCatalog.find(
					(installed) =>
						installed.id === entry.id &&
						installed.version === this.installations.get(this.attachedId(entry) ?? "")?.version,
				)?.browserMode,
				fields: inputFields(entry, this.options.root),
				authentication: entry.authentication,
				capabilities: entry.capabilities,
			})),
		];
	}
	private attachedId(entry: BundleCatalogEntry) {
		return [...this.installations.keys()].find((id) => {
			try {
				const installation = this.installations.get(id)!;
				return (
					installation.catalogId === entry.id &&
					this.manager.getServerConfig(id).identity ===
						`${installation.catalogId}@${installation.version}`
				);
			} catch {
				return false;
			}
		});
	}
	private isAttached(entry: BundleCatalogEntry) {
		return Boolean(this.attachedId(entry));
	}
	async portableSnapshot(id: string) {
		const { installation, entry } = await this.installed(id);
		return {
			version: 1 as const,
			sourceId: id,
			bundle: {
				kind: "catalog" as const,
				catalogId: entry.id,
				version: installation.version,
				artifacts: entry.artifacts.map(({ sha256, size, platforms }) => ({
					sha256,
					size,
					platforms,
				})),
			},
			configuration: reusableConnectorSettings(installation.configuration),
		};
	}

	async acknowledgeNotifications(owner: SetupNotificationOwner, ids: string[]) {
		const parsed = setupNotificationOwner.parse(owner);
		const changed: CatalogJob[] = [];
		for (const job of this.work.values()) {
			if (
				ids.includes(job.id) &&
				job.notificationOwner?.accountId === parsed.accountId &&
				job.notificationOwner.installationId === parsed.installationId &&
				job.notificationOwner.origin === parsed.origin &&
				(job.status === "completed" || job.status === "failed")
			) {
				changed.push(job);
				job.notificationDelivered = true;
			}
		}
		try {
			await this.saveJobs();
		} catch (error) {
			for (const job of changed) job.notificationDelivered = false;
			throw error;
		}
		this.options.onChange?.();
		return { count: changed.length };
	}
	jobs() {
		return [...this.work.values()].map((job) => ({
			...job,
			connectorName:
				job.connectorName ?? bundleCatalog.find((entry) => entry.id === job.catalogId)?.name,
		}));
	}
	cancel(jobId: string) {
		const job = this.work.get(jobId);
		if (!job || job.status !== "running") throw new Error("That operation is no longer running.");
		this.controllers.get(jobId)?.abort();
		return { cancelled: true };
	}
	private update(job: CatalogJob, stage: string, message: string, progress?: number) {
		Object.assign(job, { stage, message, progress });
		this.options.onChange?.();
	}
	private start(
		entry: BundleCatalogEntry,
		kind: CatalogJob["kind"],
		action: (job: CatalogJob, signal: AbortSignal) => Promise<void>,
		serverId = serverIds[entry.id]!,
	) {
		if (
			[...this.work.values()].some((job) => job.serverId === serverId && job.status === "running")
		)
			throw new Error("An operation for this connector is already running.");
		const job: CatalogJob = {
			id: randomUUID(),
			connectorName: entry.name,
			notificationOwner: this.options.notificationOwner?.(),
			catalogId: entry.id,
			serverId,
			kind,
			status: "running",
			stage: "starting",
			message: "Starting…",
			startedAt: new Date().toISOString(),
		};
		const controller = new AbortController();
		this.work.set(job.id, job);
		this.controllers.set(job.id, controller);
		this.options.onChange?.();
		void this.saveJobs()
			.then(() => action(job, controller.signal))
			.then(() => {
				assertActive(controller.signal);
				job.status = "completed";
			})
			.catch((error) => {
				job.status = controller.signal.aborted ? "cancelled" : "failed";
				job.error = controller.signal.aborted
					? "Operation cancelled. Your existing connections and sessions were preserved."
					: error instanceof Error
						? error.message
						: "The operation failed.";
				if (sessionRecoveryEnabled() && !controller.signal.aborted) {
					job.recovery = error instanceof RecoveryError ? error.recovery : classifyRecovery(error);
					job.error = recoveryMessage(job.recovery);
				}
				job.message = job.error;
			})
			.finally(() => {
				job.finishedAt = new Date().toISOString();
				void this.saveJobs().catch(() => {});
				this.controllers.delete(job.id);
				this.options.onChange?.();
			});
		return { ...job };
	}
	async install(
		input: { catalogId: string; configuration: Record<string, string>; serverId?: string },
		options: { authorize?: () => void; localOnly?: boolean } = {},
	) {
		await this.initialize();
		options.authorize?.();
		const entry = bundleCatalog.find((candidate) => candidate.id === input.catalogId);
		if (!entry) throw new Error("Unknown catalog connector.");
		const artifact = entry.artifacts.find(
			(candidate) =>
				bundleAvailable(candidate) &&
				candidate.platforms.includes(`${process.platform}-${process.arch}` as never),
		);
		if (!artifact && !browserEntry(entry))
			throw new Error("No library bundle is available for this operating system and architecture.");
		const serverId = input.serverId ?? serverIds[entry.id]!;
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(serverId)) throw new Error("Invalid instance ID");
		try {
			this.manager.getServerConfig(serverId);
			throw new Error(
				"A connection with this name already exists. Use its Authenticate or Verify action, or remove the attachment before installing again.",
			);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("A connection")) throw error;
		}
		const directory = join(
			this.options.root,
			"connectors",
			input.serverId ?? entry.id,
			entry.version,
		);
		const configuration = catalogConfiguration(
			entry,
			input.serverId
				? Object.fromEntries(
						Object.entries(input.configuration).filter(
							([key]) => !["profile_dir", "session_dir"].includes(key),
						),
					)
				: input.configuration,
			input.serverId ? join(this.options.root, "instances", serverId) : this.options.root,
			directory,
		);
		return this.start(
			entry,
			"install",
			async (job, signal) => {
				if (browserEntry(entry)) {
					await mkdir(directory, { recursive: true, mode: 0o700 });
					await this.manager.addServers(
						[
							{
								...(await browserConfig(
									entry,
									configuration,
									this.options.resources,
									this.options.nodePath,
								)),
								id: serverId,
							},
						],
						false,
						{
							localOnly: options.localOnly,
							authorize: () => {
								assertActive(signal);
								options.authorize?.();
							},
						},
					);
					this.installations.set(serverId, {
						catalogId: entry.id,
						version: entry.version,
						serverId,
						directory,
						configuration,
					});
					await this.save();
					this.update(
						job,
						"installed",
						`Installed. Use Authenticate to approve the Laplace extension in your existing ${entry.name} tab.`,
					);
					return;
				}
				if (!artifact) throw new Error("Missing bundle artifact.");
				const origin = new URL(this.options.origin ?? "https://connect.withlaplace.com");
				if (
					origin.protocol !== "https:" &&
					!(origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname))
				)
					throw new Error("Invalid bundle origin.");
				if (origin.username || origin.password || origin.search || origin.hash)
					throw new Error("Invalid bundle origin.");
				const staging = `${directory}.install-${randomUUID()}`;
				let prepared = false;
				try {
					try {
						await access(directory);
						prepared = true;
					} catch {
						/* First installation. */
					}
					if (prepared) {
						const receipt = JSON.parse(
							await readFile(join(directory, ".laplace-bundle.json"), "utf8").catch(() => "null"),
						);
						if (receipt?.sha256 !== artifact.sha256)
							throw new Error(
								"An existing bundle directory has no matching receipt. Preserve it and choose a new desktop state directory or inspect it locally.",
							);
					} else {
						this.update(job, "downloading", "Downloading the pinned bundle…", 0);
						const bytes = await downloadBundle(
							artifact.url,
							artifact,
							signal,
							this.options.fetch,
							(progress) =>
								this.update(job, "downloading", "Downloading the pinned bundle…", progress),
						);
						this.update(job, "extracting", "Verifying and extracting the bundle…");
						await extractBundle(bytes, staging, signal);
						await writeFile(
							join(staging, ".laplace-bundle.json"),
							JSON.stringify({
								sha256: artifact.sha256,
								size: artifact.size,
								version: entry.version,
							}),
							{ mode: 0o600, flag: "wx" },
						);
						assertActive(signal);
						await rename(staging, directory);
					}
					const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
					const config = {
						...resolveManifestConfiguration(manifest, entry, directory, configuration),
						id: serverId,
					};
					if (entry.recipe === "linkedin") {
						this.update(job, "dependencies", "Installing locked Python 3.13 dependencies…");
						const release = await acquireResourceLeases(config, directory);
						try {
							await this.command(
								join(
									this.options.resources,
									"runtimes",
									process.platform === "win32" ? "uv.exe" : "uv",
								),
								["sync", "--locked", "--no-dev", "--python", "3.13"],
								directory,
								{},
								signal,
								15 * 60 * 1000,
							);
						} finally {
							await release();
						}
					}
					assertActive(signal);
					await this.manager.addServers([config], false, {
						localOnly: options.localOnly,
						authorize: () => {
							assertActive(signal);
							options.authorize?.();
						},
					});
					this.installations.set(serverId, {
						catalogId: entry.id,
						version: entry.version,
						serverId,
						directory,
						configuration,
					});
					await this.save();
					this.update(
						job,
						"installed",
						"Installed. Select Authenticate to sign in and verify the connection.",
					);
				} finally {
					await rm(staging, { recursive: true, force: true });
				}
			},
			serverId,
		);
	}

	private async installed(id: string) {
		await this.initialize();
		const installation = this.installations.get(id);
		const entry = allBundleCatalog.find(
			(candidate) =>
				candidate.id === installation?.catalogId && candidate.version === installation.version,
		);
		if (
			!installation ||
			!entry ||
			this.manager.getServerConfig(id).identity !== `${entry.id}@${entry.version}`
		)
			throw new Error(
				"This connection was imported or removed. Use its original connector's login instructions, or install it from the catalog.",
			);
		return { installation, entry };
	}
	async configure(id: string, values: Record<string, string>, authorize: () => void) {
		const { installation, entry } = await this.installed(id);
		if (tetheredEntry(entry))
			return this.migrate(id, entry, { ...installation.configuration, ...values }, authorize);
		const configuration = catalogConfiguration(
			entry,
			{ ...installation.configuration, ...values },
			join(this.options.root, "instances", id),
			installation.directory,
		);
		if (browserEntry(entry)) {
			authorize();
			if (!this.manager.updateServer) throw new Error("Desktop update required");
			await this.manager.updateServer(id, {
				...(await browserConfig(
					entry,
					configuration,
					this.options.resources,
					this.options.nodePath,
				)),
				id,
			});
			installation.configuration = configuration;
			await this.save();
			return { configured: true };
		}
		const manifest = JSON.parse(
			await readFile(join(installation.directory, "manifest.json"), "utf8"),
		);
		const config = {
			...resolveManifestConfiguration(manifest, entry, installation.directory, configuration),
			id,
			enabled: false,
		};
		authorize();
		if (!this.manager.updateServer) throw new Error("Update Desktop to configure this connector");
		await this.manager.updateServer(id, config);
		installation.configuration = configuration;
		await this.save();
	}
	async repair(id: string, authorize: () => void) {
		const pending = ((await this.manager.browserMigrationRecords?.()) ?? []).find(
			(record) => record.serverId === id && ["prepared", "committing"].includes(record.state),
		);
		if (pending) {
			authorize();
			const recoveryEntry = allBundleCatalog.find(
				(entry) => pending.previous.identity === `${entry.id}@${entry.version}`,
			);
			if (!recoveryEntry)
				throw Error("Previous catalog version is unavailable; its files are preserved.");
			return this.start(
				recoveryEntry,
				"verify",
				async (job) => {
					authorize();
					await this.options.browserApprovals?.cancelByServer(id, "desktop");
					if (!this.manager.rollbackBrowserMigration) throw Error("Desktop update required.");
					await this.manager.rollbackBrowserMigration(pending.id);
					this.update(
						job,
						"restored",
						"Restored the previous connector. Its session files were preserved.",
					);
				},
				id,
			);
		}
		const { installation, entry } = await this.installed(id);
		if (browserEntry(entry)) {
			authorize();
			await this.manager.restartServer(id);
			return this.verify(id, authorize);
		}
		const artifact = entry.artifacts.find((a) =>
			a.platforms.includes(`${process.platform}-${process.arch}` as never),
		);
		if (!artifact) throw new Error("No compatible pinned artifact");
		// A repair restores this exact bundle version while retaining its separate auth profile.
		const signal = new AbortController().signal;
		const bytes = await downloadBundle(
			artifact.url,
			artifact,
			signal,
			this.options.fetch,
			() => {},
		);
		const staging = `${installation.directory}.repair-${randomUUID()}`;
		const backup = `${installation.directory}.backup-${randomUUID()}`;
		let moved = false;
		try {
			await extractBundle(bytes, staging, signal);
			await writeFile(
				join(staging, ".laplace-bundle.json"),
				JSON.stringify({ sha256: artifact.sha256, size: artifact.size, version: entry.version }),
				{ mode: 0o600 },
			);
			authorize();
			await this.manager.setEnabled(id, false);
			authorize();
			await rename(installation.directory, backup);
			moved = true;
			try {
				await rename(staging, installation.directory);
			} catch (error) {
				await rename(backup, installation.directory);
				moved = false;
				throw error;
			}
		} finally {
			await rm(staging, { recursive: true, force: true });
			if (moved) await rm(backup, { recursive: true, force: true });
		}
		return this.verify(id, authorize);
	}

	/** Only adapters with an existing exact-account consent record can broker reauthentication. */
	async brokerReauthenticationSupported(id: string): Promise<boolean> {
		const { entry } = await this.installed(id);
		return browserEntry(entry);
	}
	async migrateImported(
		input: { id: string; catalogId: string; configuration: Record<string, string>; confirm: true },
		authorize: () => void,
	) {
		await this.initialize();
		authorize();
		if (input.confirm !== true)
			throw Error("Explicit migration is required for imported configurations.");
		const entry = bundleCatalog.find(
			(entry) => entry.id === input.catalogId && tetheredEntry(entry),
		);
		if (!entry) throw Error("No activated tethered artifact is available for this catalog entry.");
		return this.migrate(input.id, entry, input.configuration, authorize);
	}
	async rollbackMigration(id: string, authorize: () => void) {
		await this.initialize();
		authorize();
		const record = [...((await this.manager.browserMigrationRecords?.()) ?? [])]
			.reverse()
			.find((record) => record.serverId === id && record.state !== "cancelled");
		if (!record || !this.manager.rollbackBrowserMigration)
			throw Error("No migration recovery record is available.");
		const entry = allBundleCatalog.find(
			(entry) => `${entry.id}@${entry.version}` === record.candidate.identity,
		)!;
		return this.start(
			entry,
			"verify",
			async (job) => {
				authorize();
				await this.options.browserApprovals?.cancelByServer(id, "desktop");
				await this.manager.rollbackBrowserMigration!(record.id);
				if (record.previousInstallation)
					this.installations.set(id, record.previousInstallation as unknown as Installation);
				else this.installations.delete(id);
				await this.save();
				this.update(
					job,
					"restored",
					"Restored the previous configuration. Session files were preserved.",
				);
			},
			id,
		);
	}

	private recordMigratedInstallation(record: BrowserMigration) {
		const entry = allBundleCatalog.find(
			(entry) =>
				entry.id === record.catalogId &&
				`${entry.id}@${entry.version}` === record.candidate.identity,
		);
		if (!entry || !record.candidate.managedBrowser)
			throw Error("Migration artifact is unavailable.");
		const directory = join(
			this.options.root,
			"connectors",
			record.serverId === serverIds[entry.id] ? entry.id : record.serverId,
			entry.version,
		);
		const configuration: Record<string, string> =
			entry.recipe === "slack-ready"
				? { workspace: record.candidate.managedBrowser.workspace }
				: {};
		this.installations.set(record.serverId, {
			catalogId: entry.id,
			version: entry.version,
			serverId: record.serverId,
			directory,
			configuration,
		});
	}
	private async migrate(
		id: string,
		entry: BundleCatalogEntry,
		values: Record<string, string>,
		authorize?: () => void,
	) {
		if (
			!this.manager.prepareBrowserMigration ||
			!this.manager.completeBrowserMigration ||
			!this.manager.rollbackBrowserMigration
		)
			throw Error("Desktop update required for migration.");
		const configuration = catalogConfiguration(
			entry,
			Object.fromEntries(
				Object.entries(values).filter(([key]) =>
					inputFields(entry, this.options.root).some((field) => field.key === key),
				),
			),
			this.options.root,
			join(this.options.root, "connectors", entry.id, entry.version),
		);
		const record = prepareBrowserMigration(
			this.manager.getServerConfig(id),
			await browserConfiguration(this.options.resources, entry.id, configuration.workspace),
		);
		const previous = this.installations.get(id);
		if (previous) record.previousInstallation = { ...previous };
		authorize?.();
		return this.start(
			entry,
			"authenticate",
			async (job, signal) => {
				const approvals = this.options.browserApprovals;
				if (!approvals) throw Error("Browser approval is unavailable.");
				await this.manager.prepareBrowserMigration!(record);
				try {
					await approvals.cancelByServer(id, "desktop");
					const receipt = record.candidate.managedBrowser!;
					await approvals.begin(
						job.id,
						id,
						receipt.provider as "outlook" | "slack-tethered",
						receipt.workspace,
						authorize,
					);
					job.browserApproval = {
						requestId: job.id,
						workspace: receipt.workspace,
						expiresAt: new Date(Date.now() + 600000).toISOString(),
						extensionDirectory: join(this.options.resources, "browser-extension"),
					};
					while (true) {
						assertActive(signal);
						authorize?.();
						const view = approvals.view(job.id, "desktop");
						this.update(job, view.state, view.message);
						if (view.state === "connected") break;
						if (["cancelled", "expired", "disconnected"].includes(view.state))
							throw Error(view.message);
						await delay(500, undefined, { signal });
					}
					assertActive(signal);
					authorize?.();
					await this.manager.completeBrowserMigration!(record.id);
					this.recordMigratedInstallation(record);
					await this.save();
					this.update(
						job,
						"migrated",
						"Verified the browser connection. Previous configuration and session files are retained for recovery.",
					);
				} catch (error) {
					const saved = ((await this.manager.browserMigrationRecords?.()) ?? []).find(
						(value) => value.id === record.id,
					);
					if (saved?.state === "prepared") {
						await approvals.cancelByServer(id, "desktop");
						await this.manager.rollbackBrowserMigration!(record.id);
					}
					throw error;
				} finally {
					delete job.browserApproval;
				}
			},
			id,
		);
	}

	async authenticate(id: string, authorize?: () => void) {
		const { installation, entry } = await this.installed(id);
		authorize?.();
		const running = [...this.work.values()].find(
			(job) => job.serverId === id && job.kind === "authenticate" && job.status === "running",
		);
		if (running) return { ...running };
		const selected = bundleCatalog.find((candidate) => candidate.id === entry.id);
		if (selected && tetheredEntry(selected) && selected.version !== entry.version)
			return this.migrate(id, selected, installation.configuration, authorize);
		return this.start(
			entry,
			"authenticate",
			async (job, signal) => {
				await this.manager.setEnabled(id, false);

				if (browserEntry(entry)) {
					const approvals = this.options.browserApprovals;
					if (!approvals) throw Error("Update Desktop to approve browser connections in chat.");
					await this.manager.setEnabled(id, true);
					const workspace =
						entry.recipe === "yc-demo"
							? ycWorkspace
							: entry.recipe === "outlook"
								? "https://outlook.cloud.microsoft"
								: installation.configuration.workspace!;
					await approvals.begin(
						job.id,
						id,
						(this.manager.getServerConfig(id).managedBrowser?.provider as
							| "slack-tethered"
							| "outlook") ??
							(entry.recipe === "yc-demo"
								? "ycombinator"
								: entry.recipe === "outlook"
									? "outlook"
									: "slack"),
						workspace,
						authorize,
					);
					job.browserApproval = {
						requestId: job.id,
						workspace,
						expiresAt: new Date(Date.now() + 600000).toISOString(),
						extensionDirectory: join(this.options.resources, "browser-extension"),
					};
					try {
						while (true) {
							assertActive(signal);
							const view = approvals.view(job.id, "desktop");
							this.update(job, view.state, view.message);
							if (view.state === "connected") break;
							if (view.state === "cancelled" || view.state === "expired") throw Error(view.message);
							await delay(500, undefined, { signal });
						}
					} catch (error) {
						await approvals.cancel(job.id, "desktop");
						await this.manager.setEnabled(id, false);
						throw error;
					} finally {
						delete job.browserApproval;
					}
					return;
				}

				const config = this.manager.getServerConfig(id);
				if (config.transport !== "stdio")
					throw new Error("Catalog authentication requires a local process.");
				const { directory, configuration } = installation;
				this.update(
					job,
					"authenticating",
					"Complete sign-in and MFA in the dedicated browser. Approve any credential-store prompt yourself.",
				);
				if (entry.recipe !== "outlook") {
					const release = await acquireResourceLeases(config, directory);
					try {
						if (entry.recipe === "slack-ready")
							await this.command(
								config.command,
								[
									join(directory, "browser/cli.mjs"),
									"login",
									"--workspace",
									configuration.workspace!,
									"--profile-dir",
									configuration.profile_dir!,
								],
								directory,
								config.env,
								signal,
								30 * 60 * 1000,
							);
						else if (entry.recipe === "canvas")
							await this.command(
								this.options.nodePath,
								[join(directory, "bin/cli.js"), "login", "--url", configuration.canvas_url!],
								directory,
								config.env,
								signal,
								30 * 60 * 1000,
							);
						else if (entry.recipe === "yale-som-ems")
							await this.command(
								this.options.nodePath,
								[
									join(directory, "dist/cli.js"),
									"login",
									"--profile-dir",
									configuration.profile_dir!,
									"--browser",
									configuration.browser!,
								],
								directory,
								config.env,
								signal,
								30 * 60 * 1000,
							);
						else
							await this.command(
								join(
									this.options.resources,
									"runtimes",
									process.platform === "win32" ? "uv.exe" : "uv",
								),
								[
									"run",
									"--locked",
									"--no-dev",
									"--python",
									"3.13",
									"--project",
									directory,
									"-m",
									"linkedin_mcp_server",
									"--login",
									"--auto-import",
									"--no-daemon",
									"--user-data-dir",
									configuration.profile_dir!,
								],
								directory,
								config.env,
								signal,
								30 * 60 * 1000,
							);
					} finally {
						await release();
					}
				} else {
					await this.manager.setEnabled(id, true);
					try {
						const result = await this.manager.catalogSetupCall(id, "outlook_login", {}, signal);
						this.assertToolResult(result);
					} catch (error) {
						await this.manager.setEnabled(id, false);
						throw error;
					}
				}
				try {
					assertActive(signal);
					await this.verifyReads(entry, job, signal);
				} catch (error) {
					await this.manager.setEnabled(id, false);
					throw error;
				}
			},
			id,
		);
	}
	async verify(id: string, authorize?: () => void) {
		const { entry } = await this.installed(id);
		authorize?.();
		if (sessionRecoveryEnabled()) {
			const pending = [...this.work.values()].find(
				(job) => job.serverId === id && job.kind === "verify" && job.status === "running",
			);
			if (pending) return { ...pending };
		}
		return this.start(
			entry,
			"verify",
			async (job, signal) => {
				const enabled = this.manager.getServerConfig(id).enabled;
				try {
					await this.verifyReads(entry, job, signal);
				} catch (error) {
					if (!sessionRecoveryEnabled()) await this.manager.setEnabled(id, false);
					throw error;
				} finally {
					if (sessionRecoveryEnabled() && this.manager.getServerConfig(id).enabled !== enabled)
						await this.manager.setEnabled(id, enabled);
				}
			},
			id,
		);
	}
	private assertToolResult(result: unknown) {
		const response = result as {
			isError?: boolean;
			structuredContent?: unknown;
			content?: Array<{ type?: string; text?: string }>;
		};
		const explicitFailure = (value: unknown) =>
			!!value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			((value as { success?: boolean }).success === false ||
				(value as { authenticated?: boolean }).authenticated === false);
		let failed = !!response?.isError || explicitFailure(response?.structuredContent);
		for (const item of response?.content ?? [])
			if (item.type === "text" && item.text) {
				try {
					if (explicitFailure(JSON.parse(item.text))) failed = true;
				} catch {
					/* Not all successful tools return JSON. */
				}
			}
		if (failed && sessionRecoveryEnabled()) {
			const failure = recoveryFromResult(response);
			if (failure && response.isError && response.structuredContent) throw failure;
			let detail: unknown = response.structuredContent;
			for (const item of response.content ?? []) {
				if (item.type === "text" && item.text) {
					try {
						detail ??= JSON.parse(item.text);
					} catch {}
				}
			}
			const data = detail as { code?: string; error?: string; authenticated?: boolean } | undefined;
			throw new RecoveryError(
				classifyRecovery(
					data?.code ??
						data?.error ??
						(data?.authenticated === false ? "sign_in_required" : detail),
				),
			);
		}
		if (failed)
			throw new Error(
				"The connector reported a sign-in or verification failure. Check its local diagnostics, then authenticate again.",
			);
	}
	private async verifyReads(entry: BundleCatalogEntry, job: CatalogJob, signal: AbortSignal) {
		this.update(job, "verifying", "Checking MCP discovery and an authenticated read…");
		if (!this.manager.getServerConfig(job.serverId).enabled)
			await this.manager.setEnabled(job.serverId, true);
		const receipt = this.manager.getServerConfig(job.serverId).managedBrowser;
		const verify =
			receipt && Object.hasOwn(browserProviders, receipt.provider)
				? [browserProviders[receipt.provider as keyof typeof browserProviders].verify]
				: checks[entry.recipe]!;
		for (const tool of verify) {
			assertActive(signal);
			let attempt = 0;
			for (;;) {
				try {
					this.assertToolResult(
						await this.manager.catalogSetupCall(job.serverId, tool, {}, signal),
					);
					delete job.recovery;
					break;
				} catch (error) {
					if (!sessionRecoveryEnabled()) throw error;
					const recovery =
						error instanceof RecoveryError ? error.recovery : classifyRecovery(error);
					if (recovery.state !== "reconnecting" || attempt >= 5) throw error;
					const suppliedDelay = (error as { retryAfterMs?: number })?.retryAfterMs;
					const wait = recoveryDelay(
						attempt++,
						typeof suppliedDelay === "number" && Number.isFinite(suppliedDelay) ? suppliedDelay : 0,
					);
					job.recovery = { ...recovery, nextRetryAt: new Date(Date.now() + wait).toISOString() };
					this.update(job, "reconnecting", recoveryMessage(recovery));
					await delay(wait, undefined, { signal });
				}
			}
		}
		this.update(job, "ready", "Connected. Authenticated read checks passed.");
	}
	private async command(
		executable: string,
		args: string[],
		cwd: string,
		extra: Record<string, string>,
		signal: AbortSignal,
		timeout: number,
	) {
		assertActive(signal);
		await new Promise<void>((accept, reject) => {
			const child = spawnLocal(
				executable,
				args,
				cwd,
				{
					...minimalEnvironment(homedir(), extra),
					PATH: [
						dirname(this.options.nodePath),
						join(this.options.resources, "runtimes"),
						process.env.PATH ?? "",
					].join(delimiter),
				},
				this.options.resources,
			);
			child.stdin.end();
			child.stdout.resume();
			child.stderr.resume();
			let killed = false;
			const stop = () => {
				killed = true;
				void stopTree(child);
			};
			const timer = setTimeout(stop, timeout);
			const aborted = () => stop();
			signal.addEventListener("abort", aborted, { once: true });
			if (signal.aborted) stop();
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", aborted);
			};
			child.once("error", () => {
				cleanup();
				reject(
					new Error(
						"Unable to launch the required runtime. Check the installed runtime and browser, then retry.",
					),
				);
			});
			child.once("close", (code) => {
				cleanup();
				if (signal.aborted) reject(abortError());
				else if (killed)
					reject(new Error("Setup timed out. Retry after checking the dedicated browser."));
				else if (code === 0) accept();
				else
					reject(
						new Error(
							"The connector setup command failed. Check its browser and runtime prerequisites, then retry.",
						),
					);
			});
		});
	}
}
