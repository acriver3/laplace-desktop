import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, isAbsolute, dirname, delimiter, sep } from "node:path";
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
import {
	serverConfig,
	minimalEnvironment,
	type NpmSource,
	type ServerConfig,
} from "@repo/local-mcp-core/config";
import type { NpmUpdateTarget } from "@repo/local-mcp-core/connector-updates";
import { acquireResourceLeases } from "@repo/local-mcp-core/leases";
import { spawnLocal, stopTree } from "@repo/local-mcp-core/process";
import { reusableConnectorSettings } from "@repo/project-protocol/portable-connectors";
import {
	setupNotificationOwner,
	type SetupNotificationOwner,
} from "@repo/project-protocol/setup-notifications";

import type { BrowserApprovals } from "./browser-approvals";
import { switchConnector } from "./connector-versions";
import {
	bundleCatalog,
	allBundleCatalog,
	tetheredEntry,
	bundleAvailable,
	npmCatalogEntry,
	npmIdentity,
	type BundleCatalogEntry,
} from "./library-catalog";
import {
	installNpmPackage,
	npmInstalledPackage,
	npmMetadata,
	resolveNpmVersion,
} from "./npm-source";
import { slackBrowserVersion } from "./shared/slack-browser";
import { ycWorkspace } from "./shared/yc-browser";
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
	/** Runtime-owned replacement that keeps npm provenance (see NpmConnectors.setVersion). */
	replaceManagedUpdate?(config: ServerConfig, expected?: ServerConfig): Promise<unknown>;
	listServers?(): Array<{ id: string; status: string; tools: Array<{ name: string }> }>;
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
	/** Installed version; npm installs follow the live configuration's npm receipt. */
	version: string;
	serverId: string;
	/** Installed package directory (npm) or extracted legacy bundle directory. */
	directory: string;
	configuration: Record<string, string>;
	/** npm package of npm installs; absent for legacy MCPB bundle installs. */
	package?: string;
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
	/** npm registry override (tests). */
	registry?: string;
	/** Defaults to requiring npm-shrinkwrap.json for Laplace packages. */
	requireShrinkwrap?: boolean;
}
const serverIds: Record<string, string> = {
	"ycombinator-demo": "ycombinator-demo",
	"canvas-session-mcp": "canvas-session",
	"linkedin-mcp-server": "linkedin",
	"yale-som-ems-mcp": "yale-som-ems",
	"yale-som-cms-mcp": "yale-som-cms",
	"msoutlook-mcp": "outlook",
	"slack-mcp-server": "slack",
};
const checks: Record<string, string[]> = {
	"yc-demo": ["list_applications"],
	canvas: ["canvas_whoami", "canvas_list_courses"],
	linkedin: ["get_my_profile"],
	"yale-som-ems": ["ems_session_status", "ems_list_templates"],
	"yale-som-cms": ["cms_session_status", "cms_get_dashboard"],
	outlook: ["outlook_status", "outlook_list_folders"],
	"slack-ready": ["channels_list"],
};
const abortError = () => new Error("Operation cancelled.");
const assertActive = (signal?: AbortSignal) => {
	if (signal?.aborted) throw abortError();
};
const uvExecutable = (resources: string) =>
	join(resources, "runtimes", process.platform === "win32" ? "uv.exe" : "uv");

const backgroundSessionField = {
	key: "background_session_checks",
	label: "Background session checks (where verified)",
	type: "select",
	options: ["off", "on"],
	default: "off",
};

const supportsBackgroundSessions = (entry: BundleCatalogEntry) =>
	entry.recipe === "canvas" || entry.recipe === "yale-som-ems";

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
			backgroundSessionField,
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
	if (entry.recipe === "yale-som-cms")
		return [
			{
				key: "state_dir",
				label: "Local state folder",
				type: "directory",
				required: true,
				default: join(session, "state"),
			},
			{
				key: "cdp_url",
				label: "Chrome remote-debugging URL",
				type: "url",
				required: true,
				default: "ws://127.0.0.1:9222/devtools/browser",
			},
			{
				key: "downloads_dir",
				label: "Career resource download folder",
				type: "directory",
				required: true,
				default: join(homedir(), "Documents", "Yale SOM CMS"),
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
			backgroundSessionField,
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
		const installRoot =
			process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory);
		if (
			field.type === "directory" &&
			(!isAbsolute(value) || normalized === installRoot || normalized.startsWith(installRoot + sep))
		)
			throw new Error(`${field.label} must be an absolute folder outside the installed connector.`);
		if (field.type === "select" && !field.options?.includes(value))
			throw new Error(field.key === backgroundSessionField.key ? "Choose on or off for background session checks." : "Choose Chrome or Edge.");
		if (field.key === "cdp_url") {
			const endpoint =
				/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})(\/devtools\/browser(?:\/[A-Za-z0-9_-]+)?)$/.exec(
					value,
				);
			if (!endpoint || Number(endpoint[2]) > 65535)
				throw new Error(
					"Use a loopback WebSocket URL with an explicit port and /devtools/browser path.",
				);
			// Preserve an explicit :80; URL serialization removes it and the connector requires a port.
			configuration[field.key] = value;
			continue;
		}
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

/**
 * Launch configuration for a catalog connector installed from npm: the package's bin with the
 * catalog's arguments and environment. Settings fill `${user_config.<key>}` and the installed
 * package directory fills `${package_dir}`; substituted values are never re-expanded.
 */
export function npmCatalogConfig(
	entry: BundleCatalogEntry,
	source: NpmSource,
	launch: { command: string; args: string[] },
	configuration: Record<string, string>,
	packageDirectory: string,
	id = serverIds[entry.id]!,
): ServerConfig & { transport: "stdio" } {
	if (!entry.npm || entry.npm.package !== source.package)
		throw new Error("This catalog connector is not distributed through npm.");
	const replace = (raw: string) =>
		raw.replace(
			/\$\{(?:user_config\.([a-z_]+)|package_dir)\}/g,
			(_match, key: string | undefined) => {
				if (key === undefined) return packageDirectory;
				if (!Object.hasOwn(configuration, key)) throw new Error("Unresolved connector setting.");
				return configuration[key]!;
			},
		);
	return serverConfig.parse({
		id,
		name: entry.name,
		transport: "stdio",
		enabled: false,
		command: launch.command,
		args: [...launch.args, ...entry.npm.args.map(replace)],
		env: {
			...Object.fromEntries(Object.entries(entry.npm.env).map(([key, value]) => [key, replace(value)])),
			...(supportsBackgroundSessions(entry)
				? { LAPLACE_BACKGROUND_SESSION_CHECKS: configuration.background_session_checks === "on" ? "on" : "off" }
				: {}),
		},
		npm: source,
		identity: npmIdentity(source),
	}) as ServerConfig & { transport: "stdio" };
}

export class CatalogInstaller {
	updateResolver?: (id: string) => Promise<
		| {
				catalogId: string;
				version: string;
				mode: "tethered" | "background-browser";
				directory: string;
		  }
		| undefined
	>;
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
	private get npmRoot() {
		return join(this.options.root, "npm-packages");
	}
	private sessionRoot(serverId: string) {
		return serverId.startsWith("pc_")
			? join(this.options.root, "instances", serverId)
			: this.options.root;
	}
	private async initialize() {
		if (this.initialized) return;
		try {
			const saved: unknown = JSON.parse(
				await readFile(join(this.options.root, "catalog-installs.json"), "utf8"),
			);
			if (Array.isArray(saved))
				for (const item of saved) {
					if (
						typeof item?.serverId !== "string" ||
						!/^[A-Za-z0-9_-]{1,80}$/.test(item.serverId) ||
						typeof item.catalogId !== "string"
					)
						continue;
					if (item.package !== undefined) {
						const entry = npmCatalogEntry(item.catalogId);
						if (!entry || entry.npm!.package !== item.package) continue;
						this.installations.set(item.serverId, {
							...item,
							configuration: catalogConfiguration(
								entry,
								item.configuration,
								this.sessionRoot(item.serverId),
								this.npmRoot,
							),
						});
						continue;
					}
					const updated = await this.updateResolver?.(item.serverId);
					// Desktop-shipped adapters match exactly; extracted bundles of npm-distributed
					// connectors stay resolvable until they are migrated to npm.
					const entry =
						allBundleCatalog.find(
							(entry) =>
								!entry.npm &&
								entry.id === item.catalogId &&
								(entry.version === item.version ||
									(updated?.catalogId === item.catalogId && updated?.mode === entry.browserMode)),
						) ?? npmCatalogEntry(item.catalogId);
					if (
						entry &&
						(item.directory === updated?.directory ||
							item.directory ===
								join(
									this.options.root,
									"connectors",
									item.serverId === serverIds[entry.id] ? entry.id : item.serverId,
									item.version,
								))
					) {
						const configuration = catalogConfiguration(
							entry,
							item.configuration,
							this.sessionRoot(item.serverId),
							item.directory,
						);
						const { package: _, ...legacy } = item;
						this.installations.set(item.serverId, {
							...legacy,
							configuration,
							// Signed-feed updates move the installation without rewriting this file.
							...(updated && updated.catalogId === item.catalogId
								? { version: updated.version, directory: updated.directory }
								: {}),
						});
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
			...bundleCatalog.map((entry) => {
				const attached = this.attachedId(entry);
				const installed = attached ? this.resolved(attached) : undefined;
				return {
					id: entry.id,
					name: entry.name,
					setupUrl: entry.setupUrl,
					browserMode: entry.browserMode,
					description: entry.description,
					version: entry.version,
					demoOnly: entry.demoOnly === true,
					repository: entry.repository,
					...(entry.npm ? { npm: { package: entry.npm.package, distTag: entry.npm.distTag } } : {}),
					available: browserEntry(entry) || bundleAvailable(entry),
					serverId: attached ?? serverIds[entry.id],
					installed: !!attached,
					installedVersion: installed?.version,
					installedBrowserMode: installed?.entry.browserMode,
					fields: inputFields(entry, this.options.root),
					authentication: entry.authentication,
					capabilities: entry.capabilities,
				};
			}),
		];
	}
	/**
	 * The installation and catalog entry a server's runtime-assigned identity proves, without
	 * consulting managed-update receipts. npm installs report the live npm version.
	 */
	private resolved(id: string) {
		const installation = this.installations.get(id);
		if (!installation) return;
		let config: ServerConfig;
		try {
			config = this.manager.getServerConfig(id);
		} catch {
			return;
		}
		if (installation.package !== undefined) {
			const entry = npmCatalogEntry(installation.catalogId);
			if (
				!entry ||
				config.transport !== "stdio" ||
				config.npm?.package !== installation.package ||
				config.identity !== npmIdentity(config.npm)
			)
				return;
			return {
				entry,
				version: config.npm.version,
				installation: {
					...installation,
					version: config.npm.version,
					directory: npmInstalledPackage(this.options.root, config.npm),
				},
			};
		}
		if (config.identity !== `${installation.catalogId}@${installation.version}`) return;
		const exact = allBundleCatalog.find(
			(candidate) =>
				!candidate.npm &&
				candidate.id === installation.catalogId &&
				candidate.version === installation.version,
		);
		if (exact) return { entry: exact, version: installation.version, installation };
		// Signed-feed releases of Desktop-shipped browser adapters keep their catalog entry.
		const browser =
			config.managedBrowser &&
			allBundleCatalog.find(
				(candidate) =>
					!candidate.npm &&
					candidate.id === installation.catalogId &&
					candidate.browserMode === "tethered",
			);
		if (browser) return { entry: browser, version: installation.version, installation };
		// A legacy extracted bundle always ran from its own directory.
		const entry = npmCatalogEntry(installation.catalogId);
		if (!entry || config.transport !== "stdio" || !config.cwd || config.managedBrowser) return;
		return { entry, version: installation.version, installation };
	}
	private attachedId(entry: BundleCatalogEntry) {
		return [...this.installations.keys()].find(
			(id) => this.installations.get(id)!.catalogId === entry.id && !!this.resolved(id),
		);
	}
	async configurationFields(id: string) {
		const { installation, entry } = await this.installed(id);
		if (!supportsBackgroundSessions(entry)) return;
		return inputFields(entry, this.options.root).map((field) => ({
			...field,
			default: installation.configuration[field.key] ?? field.default,
		}));
	}
	async portableSnapshot(id: string) {
		const { installation, entry } = await this.installed(id);
		const configuration = reusableConnectorSettings(installation.configuration);
		delete configuration[backgroundSessionField.key];
		return {
			version: 1 as const,
			sourceId: id,
			bundle: {
				kind: "catalog" as const,
				catalogId: entry.id,
				version: installation.version,
				...(installation.package ? { package: installation.package } : {}),
			},
			configuration,
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
				if ((sessionRecoveryEnabled() || error instanceof RecoveryError) && !controller.signal.aborted) {
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
		input: {
			catalogId: string;
			configuration: Record<string, string>;
			serverId?: string;
			/** Exact npm version (portable copies); defaults to the catalog's dist-tag. */
			version?: string;
		},
		options: { authorize?: () => void; localOnly?: boolean } = {},
	) {
		await this.initialize();
		options.authorize?.();
		const entry = bundleCatalog.find((candidate) => candidate.id === input.catalogId);
		if (!entry) throw new Error("Unknown catalog connector.");
		if (!browserEntry(entry) && !bundleAvailable(entry))
			throw new Error(
				"This connector is not available for this operating system and architecture.",
			);
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
			browserEntry(entry) ? directory : this.npmRoot,
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
				this.update(job, "resolving", `Looking up ${entry.npm!.package} on npm…`);
				const source = await this.resolveNpm(entry, input.version ?? entry.npm!.distTag, signal);
				this.update(job, "installing", `Installing ${source.package}@${source.version} from npm…`);
				const config = await this.npmConfig(entry, source, configuration, serverId, signal, job);
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
					version: source.version,
					serverId,
					directory: npmInstalledPackage(this.options.root, source),
					configuration,
					package: source.package,
				});
				await this.save();
				this.update(
					job,
					"installed",
					"Installed. Select Authenticate to sign in and verify the connection.",
				);
			},
			serverId,
		);
	}

	/** Resolves a dist-tag or exact version of the catalog's package to an exact release. */
	private async resolveNpm(entry: BundleCatalogEntry, spec: string, signal?: AbortSignal) {
		const metadata = await npmMetadata(entry.npm!.package, {
			registry: this.options.registry,
			fetch: this.options.fetch,
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : undefined,
		});
		return resolveNpmVersion(metadata, spec, entry.npm!.bin);
	}
	/** Package-specific setup in an installed package directory before the connector starts. */
	async prepareNpmPackage(source: NpmSource, packageDirectory: string, signal?: AbortSignal) {
		// The LinkedIn launcher runs its locked Python project with the bundled uv.
		if (source.package !== npmCatalogEntry("linkedin-mcp-server")?.npm?.package) return;
		await this.command(
			uvExecutable(this.options.resources),
			["sync", "--locked", "--no-dev", "--python", "3.13"],
			packageDirectory,
			{},
			signal ?? new AbortController().signal,
			15 * 60 * 1000,
		);
	}
	/** Installs one exact version and builds its launch configuration (disabled). */
	private async npmConfig(
		entry: BundleCatalogEntry,
		source: NpmSource,
		configuration: Record<string, string>,
		serverId: string,
		signal?: AbortSignal,
		job?: CatalogJob,
		force = false,
	) {
		const launch = await installNpmPackage(source, {
			root: this.options.root,
			resources: this.options.resources,
			registry: this.options.registry,
			requireShrinkwrap: this.options.requireShrinkwrap,
			signal,
			force,
		});
		const packageDirectory = npmInstalledPackage(this.options.root, source);
		if (entry.recipe === "linkedin" && job)
			this.update(job, "dependencies", "Installing locked Python 3.13 dependencies…");
		await this.prepareNpmPackage(source, packageDirectory, signal);
		return npmCatalogConfig(entry, source, launch, configuration, packageDirectory, serverId);
	}

	async updateEnrollment(id: string) {
		const { installation, entry } = await this.installed(id);
		if (entry.npm)
			throw new Error("This connector updates from its npm package; use Update connector.");
		const config = this.manager.getServerConfig(id);
		return {
			id,
			directory:
				config.managedBrowser && config.transport === "stdio"
					? dirname(config.args[0]!)
					: installation.directory,
			catalogId: entry.id,
			version: installation.version,
			mode: entry.browserMode,
		};
	}
	private async installed(id: string) {
		await this.initialize();
		const installation = this.installations.get(id);
		if (installation && installation.package === undefined) {
			const updated = await this.updateResolver?.(id);
			if (updated && updated.catalogId === installation.catalogId) {
				installation.version = updated.version;
				installation.directory = updated.directory;
				const base = allBundleCatalog.find(
					(candidate) =>
						candidate.id === updated.catalogId && candidate.browserMode === updated.mode,
				);
				if (
					base &&
					this.manager.getServerConfig(id).identity === `${updated.catalogId}@${updated.version}`
				)
					return {
						installation,
						entry: { ...base, version: updated.version, managedUpdate: true },
					};
			}
		}
		const resolved = this.resolved(id);
		if (!resolved)
			throw new Error(
				"This connection was imported or removed. Use its original connector's login instructions, or install it from the catalog.",
			);
		return { installation: resolved.installation, entry: resolved.entry };
	}
	async configure(id: string, values: Record<string, string>, authorize: () => void) {
		const { installation, entry } = await this.installed(id);
		if (tetheredEntry(entry))
			return this.migrate(id, entry, { ...installation.configuration, ...values }, authorize);
		const configuration = catalogConfiguration(
			entry,
			{ ...installation.configuration, ...values },
			join(this.options.root, "instances", id),
			browserEntry(entry) ? installation.directory : this.npmRoot,
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
			this.installations.get(id)!.configuration = configuration;
			await this.save();
			return { configured: true };
		}
		// A legacy bundle is reconfigured by moving it to its npm package.
		if (installation.package === undefined) {
			await this.applyNpmVersion(id, entry.npm!.distTag, undefined, { configuration, authorize });
			return { configured: true };
		}
		const previous = this.manager.getServerConfig(id);
		if (previous.transport !== "stdio" || !previous.npm)
			throw new Error("This connector is not installed from npm.");
		const template = await this.npmConfig(entry, previous.npm, configuration, id);
		authorize();
		if (!this.manager.replaceManagedUpdate)
			throw new Error("Update Desktop to configure this connector");
		const { cwd: _cwd, ...rest } = previous;
		const backgroundOnly = supportsBackgroundSessions(entry) && Object.keys(configuration).every(
			(key) => key === backgroundSessionField.key || configuration[key] === installation.configuration[key],
		);
		await this.manager.replaceManagedUpdate(
			serverConfig.parse({
				...rest,
				args: template.args,
				env: { ...previous.env, ...template.env },
				enabled: backgroundOnly && previous.enabled,
				generation: randomUUID(),
			}),
			previous,
		);
		this.installations.get(id)!.configuration = configuration;
		await this.save();
		return { configured: true };
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
		authorize();
		// A legacy bundle is repaired by moving it to its npm package.
		if (installation.package === undefined) {
			await this.applyNpmVersion(id, entry.npm!.distTag, undefined, { authorize });
			return this.verify(id, authorize);
		}
		if (!this.manager.replaceManagedUpdate) throw new Error("Desktop update required");
		// A repair reinstalls this exact npm version while retaining its separate auth profile.
		await this.manager.setEnabled(id, false);
		const previous = this.manager.getServerConfig(id);
		if (previous.transport !== "stdio" || !previous.npm)
			throw new Error("This connector is not installed from npm.");
		const template = await this.npmConfig(
			entry,
			previous.npm,
			installation.configuration,
			id,
			undefined,
			undefined,
			true,
		);
		authorize();
		const { cwd: _cwd, ...rest } = previous;
		await this.manager.replaceManagedUpdate(
			serverConfig.parse({
				...rest,
				command: template.command,
				args: template.args,
				env: { ...previous.env, ...template.env },
				generation: randomUUID(),
			}),
			previous,
		);
		return this.verify(id, authorize);
	}

	/** Catalog connectors whose updates follow their npm dist-tag, including legacy bundles. */
	async npmUpdateTargets(): Promise<NpmUpdateTarget[]> {
		await this.initialize();
		const targets: NpmUpdateTarget[] = [];
		for (const id of this.installations.keys()) {
			const resolved = this.resolved(id);
			if (!resolved?.entry.npm || browserEntry(resolved.entry)) continue;
			targets.push({
				id,
				name: this.manager.getServerConfig(id).name,
				version: resolved.version,
				legacy: resolved.installation.package === undefined,
			});
		}
		return targets;
	}
	private async npmTarget(id: string) {
		const { installation, entry } = await this.installed(id);
		if (!entry.npm || browserEntry(entry))
			throw new Error("This connector does not update from npm.");
		return { installation, entry };
	}
	/** The exact version the catalog's dist-tag names now. */
	async latestNpmVersion(id: string, signal?: AbortSignal) {
		const { entry } = await this.npmTarget(id);
		return (await this.resolveNpm(entry, entry.npm!.distTag, signal)).version;
	}
	/** Downloads and prepares a version ahead of switching to it. */
	async stageNpmVersion(id: string, version: string, signal?: AbortSignal) {
		const { installation, entry } = await this.npmTarget(id);
		const source = await this.resolveNpm(entry, version, signal);
		await this.npmConfig(entry, source, installation.configuration, id, signal);
	}
	/**
	 * Switches a catalog connector to an exact npm version (setVersion semantics): installs it in
	 * isolation, replaces the configuration atomically, restores the previous configuration when the
	 * new one fails to start, and keeps tools introduced by the new version disabled until approved.
	 * A legacy MCPB installation moves to npm the same way, keeping its settings and server ID.
	 */
	async applyNpmVersion(
		id: string,
		version: string,
		signal?: AbortSignal,
		options: { configuration?: Record<string, string>; authorize?: () => void } = {},
	) {
		const { installation, entry } = await this.npmTarget(id);
		if (!this.manager.replaceManagedUpdate || !this.manager.listServers)
			throw new Error("Desktop update required.");
		const previous = this.manager.getServerConfig(id);
		if (previous.transport !== "stdio") throw new Error("Catalog connectors run locally.");
		const legacy = installation.package === undefined;
		const source = await this.resolveNpm(entry, version, signal);
		if (
			!legacy &&
			previous.npm?.version === source.version &&
			previous.npm.integrity === source.integrity
		)
			return { changed: false, version: source.version };
		const configuration = catalogConfiguration(
			entry,
			options.configuration ?? installation.configuration,
			this.sessionRoot(id),
			this.npmRoot,
		);
		const template = await this.npmConfig(entry, source, configuration, id, signal);
		signal?.throwIfAborted();
		options.authorize?.();
		if (JSON.stringify(this.manager.getServerConfig(id)) !== JSON.stringify(previous))
			throw new Error("Connector changed while the new version was downloading. Try again.");
		const { cwd: _cwd, ...rest } = previous;
		const { listServers, replaceManagedUpdate } = this.manager;
		const { toolsAwaitingApproval } = await switchConnector(
			{
				listServers: () => listServers.call(this.manager),
				replaceManagedUpdate: (config, expected) =>
					replaceManagedUpdate.call(this.manager, config, expected),
			},
			previous,
			(knownTools) =>
				serverConfig.parse({
					...rest,
					command: template.command,
					args: template.args,
					// Legacy environments came from the bundle manifest; npm ones may hold user settings.
					env: legacy ? template.env : { ...previous.env, ...template.env },
					npm: source,
					identity: template.identity,
					generation: randomUUID(),
					...(options.configuration ? { enabled: false } : {}),
					// Pin today's tool set so tools introduced by the new version start disabled.
					enabledTools: previous.enabledTools ?? knownTools,
				}),
			`${source.package}@${source.version} failed to start; the previous version was restored.`,
		);
		this.installations.set(id, {
			catalogId: entry.id,
			version: source.version,
			serverId: id,
			directory: npmInstalledPackage(this.options.root, source),
			configuration,
			package: source.package,
		});
		await this.save();
		this.options.onChange?.();
		return {
			changed: true,
			version: source.version,
			previousVersion: installation.version,
			migrated: legacy,
			toolsAwaitingApproval,
		};
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
					entry.recipe === "yale-som-cms"
						? "Keep Chrome open with remote debugging enabled. Approve Chrome’s connection prompt and complete Yale sign-in/MFA in the connector’s CMS tab."
						: "Complete sign-in and MFA in the dedicated browser. Approve any credential-store prompt yourself.",
				);
				if (entry.recipe !== "outlook") {
					// npm installs run the package's bin; legacy bundles their extracted entry point.
					const entryPoint = (legacyPath: string) =>
						config.npm
							? config.command === "node"
								? [this.options.nodePath, config.args[0]!]
								: [config.command]
							: [this.options.nodePath, join(directory, legacyPath)];
					const release = await acquireResourceLeases(config, directory);
					try {
						const [executable, ...prefix] =
							entry.recipe === "slack-ready"
								? config.npm
									? entryPoint("browser/cli.mjs")
									: [config.command, join(directory, "browser/cli.mjs")]
								: entry.recipe === "canvas"
									? entryPoint("bin/cli.js")
									: entry.recipe === "yale-som-ems" || entry.recipe === "yale-som-cms"
										? entryPoint("dist/cli.js")
										: config.npm
											? entryPoint("")
											: [
													uvExecutable(this.options.resources),
													"run",
													"--locked",
													"--no-dev",
													"--python",
													"3.13",
													"--project",
													directory,
													"-m",
													"linkedin_mcp_server",
												];
						const args =
							entry.recipe === "slack-ready"
								? [
										"login",
										"--workspace",
										configuration.workspace!,
										"--profile-dir",
										configuration.profile_dir!,
									]
								: entry.recipe === "canvas"
									? ["login", "--url", configuration.canvas_url!]
									: entry.recipe === "yale-som-cms"
										? [
												"login",
												"--state-dir",
												configuration.state_dir!,
												"--cdp-url",
												configuration.cdp_url!,
												"--downloads-dir",
												configuration.downloads_dir!,
											]
										: entry.recipe === "yale-som-ems"
											? [
													"login",
													"--profile-dir",
													configuration.profile_dir!,
													"--browser",
													configuration.browser!,
												]
											: [
													"--login",
													"--auto-import",
													"--no-daemon",
													"--user-data-dir",
													configuration.profile_dir!,
												];
						await this.command(
							executable!,
							[...prefix, ...args],
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
					if (!sessionRecoveryEnabled() && !(error instanceof RecoveryError))
						await this.manager.setEnabled(id, false);
					else if (this.manager.getServerConfig(id).enabled !== enabled)
						await this.manager.setEnabled(id, enabled);
					throw error;
				} finally {
					if (sessionRecoveryEnabled() && this.manager.getServerConfig(id).enabled !== enabled)
						await this.manager.setEnabled(id, enabled);
				}
			},
			id,
		);
	}
	private assertToolResult(result: unknown, sessionConnector = false) {
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
		const code = (response?.structuredContent as { code?: string } | undefined)?.code;
		const sessionFailure = sessionConnector && typeof code === "string" &&
			["sign_in_required", "auth_required", "identity_mismatch", "rate_limited", "transport_unavailable"].includes(code);
		if (failed && sessionFailure) {
			const recovery = classifyRecovery(code === "auth_required" ? "sign_in_required" : code);
			const details = response.structuredContent as { details?: { retryAfterMs?: number } };
			throw new RecoveryError(
				code === "transport_unavailable" ? { state: "reconnecting", reason: code } : recovery,
				details.details?.retryAfterMs,
			);
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
						supportsBackgroundSessions(entry),
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
					// The LinkedIn launcher runs its Python project with Laplace's uv.
					LAPLACE_UV: uvExecutable(this.options.resources),
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
