import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, lstat, readdir, statfs } from "node:fs/promises";
import { join, resolve, sep, basename, dirname, relative, isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";

import { z } from "zod";

import { serverConfig, type ServerConfig } from "./config";
import {
	connectorSigningKey,
	connectorRelease,
	connectorIndex,
	type ConnectorRelease,
	type ConnectorIndex,
	boundedDownload,
	retryingDownload,
	verifyConnectorIndex,
	assertIndexSuccessor,
	sha256,
	compatibleHost,
} from "./connector-releases";
import { EncryptedStore } from "./encrypted-store";
import type { EntryFactory } from "./store";
import { recoverUpdateCoordination } from "./update-coordination";
import { computerIdleSeconds } from "./update-idle";
import { UpdatePolicyStore, updateInstanceKey, automaticUpdatesEnabled } from "./update-policy";

const receipt = z.object({
	id: z.string(),
	directory: z.string(),
	release: connectorRelease,
	config: serverConfig,
});
const journal = z.object({ previous: receipt, candidate: receipt });
const document = z.object({
	installations: z.array(receipt).default([]),
	/** Version each npm-distributed connector's dist-tag named at the last check. */
	npm: z.record(z.string(), z.object({ version: z.string().max(100) })).default({}),
	journal: journal.optional(),
	failed: z.record(z.string(), z.string()).default({}),
	proof: z.object({ payload: z.string(), signature: z.string() }).optional(),
	index: connectorIndex.optional(),
});
type Receipt = z.infer<typeof receipt>;
/** A catalog connector distributed through npm; its updates follow the catalog's dist-tag. */
export interface NpmUpdateTarget {
	id: string;
	name: string;
	version: string;
	/** Still runs a legacy MCPB bundle; updating moves it to the npm package. */
	legacy: boolean;
}
export interface NpmUpdateHost {
	targets(): Promise<NpmUpdateTarget[]>;
	/** The exact version the connector's dist-tag names now. */
	latest(id: string, signal: AbortSignal): Promise<string>;
	/** Downloads and prepares a version ahead of switching to it. */
	stage?(id: string, version: string, signal: AbortSignal): Promise<void>;
	/**
	 * Switches to an exact version with setVersion semantics: atomic replacement, the previous
	 * configuration restored when the new one fails to start, and new tools held for approval.
	 */
	apply(id: string, version: string, signal: AbortSignal): Promise<unknown>;
}
export interface ConnectorUpdateHost {
	root: string;
	version: string;
	kind: "desktop" | "cli";
	configurations(): Promise<ServerConfig[]>;
	retainForEnrollment?(config: ServerConfig): Promise<ServerConfig>;
	replace(config: ServerConfig, expected?: ServerConfig): Promise<void>;
	verify(id: string): Promise<void>;
	maintenance(id: string): Promise<(() => void) | undefined>;
	busy(): boolean;
	idleSeconds?(): Promise<number | undefined>;
	toolNames?(id: string): string[];
	entries?: EntryFactory;
	/**
	 * Identifies the host's own bundled runtimes. Catalog installs may launch connectors with
	 * them by full path (for example the Windows runtime's node.exe) instead of the bare alias.
	 */
	bundledRuntime?(command: string): "node" | "uv" | undefined;
	/**
	 * npm-distributed catalog connectors. They update from npm instead of the signed feed, which
	 * remains for Desktop-shipped browser adapters and legacy bundles that have not migrated yet.
	 */
	npm?: NpmUpdateHost;
}
export interface ConnectorUpdateStatus {
	id: string;
	version: string;
	availableVersion?: string;
	pinned: boolean;
	message?: string;
	/** True when `message` describes something that prevents installing (not just a retry hint). */
	blocked?: boolean;
	name?: string;
	phase?: "downloading" | "installing" | "idle";
}
const feed =
	"https://raw.githubusercontent.com/acriver3/laplace-mcp-library/main/updates/stable.json";
/** Compare filesystem paths the way the OS does: separators normalized, case-insensitive on Windows. */
const pathKey = (path: string) => {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);
const insidePath = (child: string, parent: string) =>
	pathKey(child).startsWith(pathKey(parent) + sep);
/** Files the uv recipe creates inside the LinkedIn project (its environment and bytecode). */
const generatedPythonPath = (path: string) =>
	path === ".venv" || path.split("/").includes("__pycache__");
export { connectorSigningKey } from "./connector-releases";
export class ConnectorUpdates {
	private store: EncryptedStore<z.infer<typeof document>>;
	private active = false;
	private transfers = new Map<string, AbortController>();
	private installing = new Set<string>();
	private npmProblems = new Map<string, string>();
	cancel(id?: string) {
		for (const [key, controller] of this.transfers)
			if ((!id || key === id) && !this.installing.has(key)) controller.abort();
	}
	private async transfer<T>(
		id: string,
		signal: AbortSignal,
		automatic: boolean,
		work: (signal: AbortSignal) => Promise<T>,
	) {
		const controller = new AbortController();
		this.transfers.set(id, controller);
		let polling = false;
		const timer = automatic
			? setInterval(() => {
					if (polling || this.installing.has(id)) return;
					polling = true;
					void this.policy
						.read()
						.then((p) => {
							if (
								!p.connectors ||
								p.pins[updateInstanceKey(this.host.root, id)] ||
								p.deferredUntil > Date.now()
							)
								controller.abort();
						})
						.catch(() => controller.abort())
						.finally(() => {
							polling = false;
						});
				}, 250)
			: undefined;
		try {
			return await work(AbortSignal.any([signal, controller.signal]));
		} finally {
			clearInterval(timer);
			this.transfers.delete(id);
			this.installing.delete(id);
		}
	}
	constructor(
		private host: ConnectorUpdateHost,
		private policy = new UpdatePolicyStore(),
		private key = connectorSigningKey,
		private fetcher = fetch,
	) {
		this.store = new EncryptedStore(
			host.root,
			"connector-updates",
			document,
			() => document.parse({}),
			host.entries,
		);
	}
	private async exclusive<T>(work: () => Promise<T>): Promise<T> {
		await mkdir(this.host.root, { recursive: true, mode: 0o700 });
		const path = join(this.host.root, "connector-update.lock");
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let pid: number;
			try {
				pid = Number(await readFile(join(path, "pid"), "utf8"));
			} catch {
				throw Error(
					"Connector update lock is incomplete; inspect local processes before recovery.",
				);
			}
			if (!Number.isSafeInteger(pid) || pid < 1) throw Error("Invalid connector update lock");
			try {
				process.kill(pid, 0);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
					const recovery = join(path, "recovery");
					await mkdir(recovery);
					try {
						if (Number(await readFile(join(path, "pid"), "utf8")) !== pid)
							throw Error("Update lock ownership changed; retry.");
						await rm(path, { recursive: true });
					} finally {
						await rm(recovery, { recursive: true, force: true });
					}
					return this.exclusive(work);
				}
				throw cause;
			}
			throw Error(
				"Another connector updater owns this installation; retry after it completes.",
			);
		}
		await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600, flag: "wx" });
		try {
			return await work();
		} finally {
			await rm(path, { recursive: true });
		}
	}
	async check(signal = new AbortController().signal) {
		return this.exclusive(async () => {
			await this.checkNpmLocked(signal);
			return this.checkLocked(signal);
		});
	}
	private async npmTargets() {
		return (await this.host.npm?.targets()) ?? [];
	}
	/** Records the version each npm connector's dist-tag names; one failure never blocks others. */
	private async checkNpmLocked(signal: AbortSignal) {
		if (!this.host.npm) return;
		const targets = await this.npmTargets();
		const found: Record<string, { version: string }> = {};
		for (const target of targets) {
			try {
				found[target.id] = { version: await this.host.npm.latest(target.id, signal) };
				this.npmProblems.delete(target.id);
			} catch (error) {
				signal.throwIfAborted();
				this.npmProblems.set(
					target.id,
					error instanceof Error ? error.message : "The npm registry could not be checked.",
				);
			}
		}
		await this.store.mutate((state) => {
			const previous = state.npm;
			state.npm = {};
			for (const target of targets) {
				const value = found[target.id] ?? previous[target.id];
				if (value) state.npm[target.id] = value;
			}
		});
	}
	private npmCandidate(
		target: NpmUpdateTarget,
		state: z.infer<typeof document>,
	): string | undefined {
		const version = state.npm[target.id]?.version;
		return version && (target.legacy || version !== target.version) ? version : undefined;
	}
	private async checkLocked(signal: AbortSignal) {
		const [bytes, signature] = await Promise.all([
			boundedDownload(feed, 16 * 1024 * 1024, signal, this.fetcher),
			boundedDownload(feed + ".sig", 64, signal, this.fetcher),
		]);
		const index = verifyConnectorIndex(bytes, signature, this.key);
		await this.store.mutate((state) => {
			assertIndexSuccessor(state.index, index);
			state.index = index;
			state.proof = {
				payload: bytes.toString("base64"),
				signature: signature.toString("base64"),
			};
		});
		return this.status();
	}
	private candidate(installed: Receipt, index?: ConnectorIndex) {
		return index?.releases
			.filter(
				(r) =>
					r.id === installed.release.id &&
					r.mode === installed.release.mode &&
					r.sequence > installed.release.sequence &&
					r.platforms.includes(`${process.platform}-${process.arch}` as never),
			)
			.sort((a, b) => b.sequence - a.sequence)[0];
	}
	private reason(installed: Receipt, release: ConnectorRelease) {
		if ((release.minBrowserProtocol ?? 1) > 1)
			return "Update Laplace and its browser extension to support this connector's browser protocol.";
		if ((release.sessionRevision ?? "1") !== (installed.release.sessionRevision ?? "1"))
			return "This release requires explicit session migration; your existing session is preserved.";
		if (
			!compatibleHost(
				this.host.version,
				this.host.kind === "desktop" ? release.minDesktop : release.minCli,
			)
		)
			return "Update the Laplace host before installing this connector release.";
		if (release.permissionRevision !== installed.release.permissionRevision)
			return "This release requires new browser permission approval.";
		if (release.configurationRevision !== installed.release.configurationRevision)
			return "This release requires manual configuration migration.";
	}
	async installed(id: string) {
		const installation = (await this.store.read()).installations.find((i) => i.id === id);
		return (
			installation && {
				catalogId: installation.release.id,
				version: installation.release.version,
				mode: installation.release.mode,
				directory: installation.directory,
			}
		);
	}
	async relocate(id: string, config: ServerConfig) {
		return this.exclusive(async () => {
			const installed = (await this.store.read()).installations.find((i) => i.id === id);
			if (!installed) return;
			if (config.transport !== "stdio" || config.identity !== installed.config.identity)
				throw Error("Connector identity changed during retention");
			const directory = resolve(config.args[0]!, "..");
			await this.verifyFiles(directory, installed.release);
			await this.store.mutate((state) => {
				const item = state.installations.find((i) => i.id === id)!;
				item.config = config;
				item.directory = directory;
			});
		});
	}
	async status(): Promise<ConnectorUpdateStatus[]> {
		const [state, policy, targets] = await Promise.all([
			this.store.read(),
			this.policy.read(),
			this.npmTargets(),
		]);
		const npmRows = targets.map((target): ConnectorUpdateStatus => {
			const candidate = this.npmCandidate(target, state);
			return {
				id: target.id,
				name: target.name,
				phase: this.installing.has(target.id)
					? "installing"
					: this.transfers.has(target.id)
						? "downloading"
						: "idle",
				version: target.version,
				availableVersion: candidate,
				pinned: !!policy.pins[updateInstanceKey(this.host.root, target.id)],
				message:
					this.npmProblems.get(target.id) ??
					(candidate && state.failed[target.id] === candidate
						? "Previous update failed. Use manual update to retry."
						: target.legacy
							? "Moves from its legacy bundle to the npm package; settings and sessions are kept."
							: undefined),
			};
		});
		const npmIds = new Set(targets.map((target) => target.id));
		return [...npmRows, ...this.feedStatus(state, policy, npmIds)];
	}
	private feedStatus(
		state: z.infer<typeof document>,
		policy: Awaited<ReturnType<UpdatePolicyStore["read"]>>,
		npmIds: Set<string>,
	): ConnectorUpdateStatus[] {
		const feed = state.installations.filter((installed) => !npmIds.has(installed.id));
		return feed.map((installed) => {
			const candidate = this.candidate(installed, state.index);
			const interrupted = state.journal?.previous.id === installed.id;
			return {
				blocked: interrupted || (!!candidate && !!this.reason(installed, candidate)),
				id: installed.id,
				name: installed.config.name,
				phase: this.installing.has(installed.id)
					? "installing"
					: this.transfers.has(installed.id)
						? "downloading"
						: "idle",
				version: installed.release.version,
				availableVersion: candidate?.version,
				pinned: !!policy.pins[updateInstanceKey(this.host.root, installed.id)],
				message: interrupted
					? "Interrupted update requires recovery."
					: candidate
						? (this.reason(installed, candidate) ??
							(state.failed[installed.id] === candidate.version
								? "Previous update failed. Use manual update to retry."
								: undefined))
						: undefined,
			};
		});
	}
	async pin(id: string, pinned: boolean) {
		await this.policy.mutate((policy) => {
			policy.pins[updateInstanceKey(this.host.root, id)] = pinned;
		});
	}
	private async verifyFiles(directory: string, release: ConnectorRelease) {
		const expected = new Set(release.files.map((f) => f.path));
		const python = release.id === "linkedin-mcp-server";
		const walk = async (relative = "") => {
			for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
				const path = relative ? relative + "/" + entry.name : entry.name;
				// uv sync and Python create these locally; every published file is still verified below.
				if (python && !expected.has(path) && generatedPythonPath(path)) continue;
				if (entry.isSymbolicLink()) throw Error("Linked connector file rejected");
				if (entry.isDirectory()) await walk(path);
				else if (
					!expected.has(path) &&
					![
						".laplace-release.json",
						".laplace-retained.json",
						".laplace-bundle.json",
					].includes(path)
				)
					throw Error(
						"Connector bundle contains unverified files; enrollment requires an exact published artifact.",
					);
			}
		};
		await walk();
		for (const file of release.files) {
			const path = join(directory, file.path);
			// Check every ancestor, not only the leaf, before following filesystem paths.
			let current = directory;
			if ((await lstat(current)).isSymbolicLink())
				throw Error("Linked connector directory rejected");
			for (const part of file.path.split("/")) {
				current = join(current, part);
				if ((await lstat(current)).isSymbolicLink())
					throw Error("Linked connector file rejected");
			}
			const bytes = await readFile(path);
			if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
				throw Error("Connector integrity check failed");
		}
	}
	async enroll(
		id: string,
		directory: string,
		catalogId: string,
		version: string,
		mode: "tethered" | "background-browser",
	) {
		return this.exclusive(() => this.enrollLocked(id, directory, catalogId, version, mode));
	}
	private async enrollLocked(
		id: string,
		directory: string,
		catalogId: string,
		version: string,
		mode: "tethered" | "background-browser",
	) {
		const state = await this.store.read();
		const release = state.index?.releases.find(
			(r) =>
				r.id === catalogId &&
				r.version === version &&
				r.mode === mode &&
				r.platforms.includes(`${process.platform}-${process.arch}` as never),
		);
		if (!release)
			throw Error(
				"Check for updates first; the installed version must have a signed release receipt.",
			);
		let config = (await this.host.configurations()).find((c) => c.id === id);
		if (
			!config ||
			config.transport !== "stdio" ||
			(config.identity && config.identity !== `${catalogId}@${version}`)
		)
			throw Error("Only a matching verified managed connector can be enrolled.");
		let source = resolve(directory);
		const launch = config;
		const entry = launch.args[0];
		const bundled = this.host.bundledRuntime?.(config.command);
		const nodeCommand =
			/^node(\.exe)?$/i.test(config.command) ||
			bundled === "node" ||
			release.files.some(
				(file) =>
					file.executable &&
					samePath(join(source, file.path), launch.command) &&
					/^(node|node.exe)$/i.test(basename(file.path)),
			);
		const nodeRecipe =
			nodeCommand &&
			!!entry &&
			release.files.some(
				(file) =>
					samePath(join(source, file.path), entry) && /\.(mjs|cjs|js)$/.test(file.path),
			);
		const uvPrefix = [
			"run",
			"--locked",
			"--no-dev",
			"--python",
			"3.13",
			"--project",
			source,
			"-m",
			"linkedin_mcp_server",
		];
		const uvRecipe =
			catalogId === "linkedin-mcp-server" &&
			(/^uv(\.exe)?$/i.test(config.command) || bundled === "uv") &&
			uvPrefix.every((value, i) =>
				value === source
					? !!launch.args[i] && samePath(launch.args[i]!, source)
					: launch.args[i] === value,
			);
		if (!nodeRecipe && !uvRecipe)
			throw Error(
				"Enrollment requires a maintained local launch recipe and the exact published entry; custom executables remain unmanaged.",
			);
		if (
			!config.args.some((arg) => insidePath(arg, source)) &&
			!(config.cwd && samePath(config.cwd, source)) &&
			!insidePath(config.command, source)
		)
			throw Error("Connector executable does not belong to the selected bundle");

		let maintenance: (() => void) | undefined;
		const original = config;
		let switched = false;
		try {
			if (mode === "tethered" && config.managedBrowser && this.host.retainForEnrollment) {
				if (this.host.busy())
					throw Error("Connector is busy; retry enrollment after local work finishes");
				maintenance = await this.host.maintenance(id);
				if (!maintenance) throw Error("Connector is busy; retry enrollment shortly");
				const retained = await this.host.retainForEnrollment(config);
				if (retained.transport !== "stdio")
					throw Error("Invalid retained connector transport");
				if (retained !== config) {
					config = retained;
					source = dirname(retained.args[0]!);
				}
			}
			await this.verifyFiles(source, release);
			if (config !== original) {
				switched = true;
				await this.host.replace(config, original);
				if (config.enabled) await this.host.verify(id);
			}
			await this.store.mutate((s) => {
				s.installations = s.installations.filter((i) => i.id !== id);
				s.installations.push({ id, directory: source, release, config: config! });
			});
		} catch (error) {
			if (switched) {
				const current = (await this.host.configurations()).find((c) => c.id === id);
				if (JSON.stringify(current) === JSON.stringify(config))
					await this.host.replace(original, config);
			}
			throw error;
		} finally {
			maintenance?.();
		}
	}
	private async stage(release: ConnectorRelease, signal: AbortSignal) {
		const directory = join(
			this.host.root,
			"managed-updates",
			release.id,
			`${release.version}-${sha256(Buffer.from(JSON.stringify(release))).slice(0, 16)}`,
		);
		try {
			await this.verifyFiles(directory, release);
			return directory;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const disk = await statfs(this.host.root);
		if (
			disk.bavail * disk.bsize <
			release.files.reduce((sum, file) => sum + file.size, 0) + 10 * 1024 ** 2
		)
			throw Error("Not enough free disk space to stage the connector update.");
		const temporary = directory + "." + randomUUID();
		await mkdir(temporary, { recursive: true, mode: 0o700 });
		try {
			for (const file of release.files) {
				signal.throwIfAborted();
				const url = `https://raw.githubusercontent.com/acriver3/laplace-mcp-library/${release.commit}/${release.directory}/${file.path.split("/").map(encodeURIComponent).join("/")}${file.compressed ? ".gz" : ""}`;
				// Empty files need no transfer (the CDN intermittently answers 501 for them).
				let bytes =
					file.size === 0 && !file.compressed
						? Buffer.alloc(0)
						: await retryingDownload(
								url,
								file.compressed?.size ?? file.size,
								signal,
								this.fetcher,
							);
				if (file.compressed) {
					if (
						bytes.length !== file.compressed.size ||
						sha256(bytes) !== file.compressed.sha256
					)
						throw Error("Compressed connector download failed integrity verification");
					bytes = gunzipSync(bytes, { maxOutputLength: Math.max(1, file.size) });
				}
				if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
					throw Error("Connector download failed integrity verification");
				const path = join(temporary, file.path);
				await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
				await writeFile(path, bytes, { flag: "wx", mode: file.executable ? 0o755 : 0o600 });
			}
			const state = await this.store.read();
			if (!state.proof) throw Error("Signed release proof unavailable");
			const verified = verifyConnectorIndex(
				Buffer.from(state.proof.payload, "base64"),
				Buffer.from(state.proof.signature, "base64"),
				this.key,
			);
			if (!verified.releases.some((item) => JSON.stringify(item) === JSON.stringify(release)))
				throw Error("Release proof changed during staging");
			await writeFile(
				join(temporary, ".laplace-release.json"),
				JSON.stringify({
					...state.proof,
					id: release.id,
					version: release.version,
					mode: release.mode,
				}),
				{ mode: 0o600, flag: "wx" },
			);
			await rename(temporary, directory);
			return directory;
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
	private rebase(installed: Receipt, release: ConnectorRelease, directory: string): ServerConfig {
		const config = structuredClone(installed.config);
		if (config.transport !== "stdio") throw Error("Only managed stdio connectors can update");
		// Compare as paths: Windows installs record entries like ...\0.1.0/bin/cli.js.
		const replace = (value: string) =>
			isAbsolute(value) && samePath(value, installed.directory)
				? directory
				: isAbsolute(value) && insidePath(value, installed.directory)
					? join(directory, relative(installed.directory, value))
					: value;
		config.command = replace(config.command);
		config.args = config.args.map(replace);
		if (config.cwd) config.cwd = replace(config.cwd);
		// Only rebase environment references to verified artifact files. Profile,
		// credential and other mutable data paths must retain their original location.
		const artifactPaths = installed.release.files.map((file) =>
			join(installed.directory, file.path),
		);
		config.env = Object.fromEntries(
			Object.entries(config.env).map(([key, value]) => [
				key,
				isAbsolute(value) && artifactPaths.some((path) => samePath(path, value))
					? replace(value)
					: value,
			]),
		);
		config.identity = `${release.id}@${release.version}`;
		config.generation = randomUUID();
		// Tethered releases must preserve the single self-contained entry's name.
		if (config.managedBrowser) {
			const entry = release.files.find((f) => config.args.includes(join(directory, f.path)));
			if (!entry) throw Error("Tethered connector entry changed; manual migration required");
			config.managedBrowser.runtimeVersion = release.version;
			config.managedBrowser.artifactSha256 = entry.sha256;
		}
		return config;
	}
	async prepare(id: string, signal = new AbortController().signal, automatic = false) {
		return this.exclusive(() =>
			this.transfer(id, signal, automatic, async (signal) => {
				const state = await this.store.read();
				const target = (await this.npmTargets()).find((item) => item.id === id);
				if (target) {
					const version = this.npmCandidate(target, state);
					if (version && state.failed[id] !== version)
						await this.host.npm!.stage?.(id, version, signal);
					return;
				}
				const installed = state.installations.find((i) => i.id === id);
				const candidate = installed && this.candidate(installed, state.index);
				if (installed && candidate && !this.reason(installed, candidate))
					await this.stage(candidate, signal);
			}),
		);
	}
	async apply(
		id: string,
		automatic = false,
		signal = new AbortController().signal,
		retain = false,
	) {
		return this.exclusive(() =>
			this.transfer(id, signal, automatic, (signal) =>
				this.applyLocked(id, automatic, signal, retain),
			),
		);
	}
	private async applyLocked(
		id: string,
		automatic: boolean,
		signal: AbortSignal,
		retain: boolean,
	) {
		if (automatic && !automaticUpdatesEnabled())
			throw Error("Automatic updates are not activated");
		const target = (await this.npmTargets()).find((item) => item.id === id);
		if (target) return this.applyNpmLocked(target, automatic, signal);
		if (this.active) throw Error("A connector update is already running");
		this.active = true;
		let unlock: (() => void) | undefined;
		try {
			const state = await this.store.read();
			if (state.journal) throw Error("Recover the interrupted connector update first");
			const installed = state.installations.find((i) => i.id === id);
			if (!installed) throw Error("Connector is not enrolled for managed updates");
			const release = retain ? installed.release : this.candidate(installed, state.index);
			if (!release) return;
			const reason = this.reason(installed, release);
			if (reason) throw Error(reason);
			const policy = await this.policy.read();
			if (
				automatic &&
				((await (this.host.idleSeconds?.() ?? computerIdleSeconds())) ?? -1) < 900
			)
				return;
			if (
				automatic &&
				(!policy.connectors ||
					policy.pins[updateInstanceKey(this.host.root, id)] ||
					policy.deferredUntil > Date.now() ||
					state.failed[id] === release.version)
			)
				return;
			const directory = await this.stage(release, signal);
			await this.verifyFiles(directory, release);
			signal.throwIfAborted();
			if (this.host.busy()) throw Error("Local work is active; update deferred");
			unlock = await this.host.maintenance(id);
			if (!unlock) throw Error("Connector is busy; update deferred");
			const current = (await this.host.configurations()).find((c) => c.id === id);
			if (JSON.stringify(current) !== JSON.stringify(installed.config))
				throw Error(
					"Connector configuration changed; enroll its reviewed configuration again",
				);
			const latestPolicy = await this.policy.read();
			if (
				automatic &&
				(!latestPolicy.connectors ||
					latestPolicy.pins[updateInstanceKey(this.host.root, id)] ||
					latestPolicy.deferredUntil > Date.now())
			)
				return;
			if (
				automatic &&
				(((await (this.host.idleSeconds?.() ?? computerIdleSeconds())) ?? -1) < 900 ||
					this.host.busy())
			)
				return;
			signal.throwIfAborted();
			this.installing.add(id);
			const candidate = {
				id,
				directory,
				release,
				config: this.rebase(installed, release, directory),
			};
			const previousTools =
				installed.config.enabled && !installed.config.enabledTools
					? this.host.toolNames?.(id)
					: undefined;
			await this.store.mutate((s) => {
				s.journal = { previous: installed, candidate };
			});
			try {
				await this.host.replace(candidate.config, installed.config);
				if (candidate.config.enabled) await this.host.verify(id);
				if (
					previousTools &&
					this.host.toolNames?.(id).some((tool) => !previousTools.includes(tool))
				)
					throw Error(
						"This connector adds tools that require explicit permission review.",
					);
				await this.store.mutate((s) => {
					s.installations = s.installations.map((i) => (i.id === id ? candidate : i));
					delete s.journal;
					delete s.failed[id];
				});
			} catch (error) {
				const observed = (await this.host.configurations()).find((c) => c.id === id);
				if (JSON.stringify(observed) === JSON.stringify(candidate.config))
					await this.host.replace(installed.config, candidate.config);
				else if (JSON.stringify(observed) !== JSON.stringify(installed.config))
					throw Error(
						"Connector changed during update; recovery journal retained for review.",
					);
				await this.store.mutate((s) => {
					delete s.journal;
					s.failed[id] = release.version;
				});
				throw error;
			}
		} finally {
			unlock?.();
			this.active = false;
		}
	}
	/**
	 * Follows the catalog's npm dist-tag. Automatic runs honor the same policy as signed-feed
	 * updates (connector updates switched on, pins, deferral, idle time, failed versions).
	 */
	private async applyNpmLocked(target: NpmUpdateTarget, automatic: boolean, signal: AbortSignal) {
		if (this.active) throw Error("A connector update is already running");
		this.active = true;
		let unlock: (() => void) | undefined;
		const id = target.id;
		try {
			const state = await this.store.read();
			const version = this.npmCandidate(target, state);
			if (!version) return;
			const blocked = async () => {
				const policy = await this.policy.read();
				return (
					automatic &&
					(!policy.connectors ||
						policy.pins[updateInstanceKey(this.host.root, id)] ||
						policy.deferredUntil > Date.now() ||
						state.failed[id] === version ||
						((await (this.host.idleSeconds?.() ?? computerIdleSeconds())) ?? -1) < 900)
				);
			};
			if (await blocked()) return;
			await this.host.npm!.stage?.(id, version, signal);
			signal.throwIfAborted();
			if (this.host.busy()) throw Error("Local work is active; update deferred");
			unlock = await this.host.maintenance(id);
			if (!unlock) throw Error("Connector is busy; update deferred");
			if ((await blocked()) || (automatic && this.host.busy())) return;
			signal.throwIfAborted();
			this.installing.add(id);
			try {
				await this.host.npm!.apply(id, version, signal);
			} catch (error) {
				await this.store.mutate((s) => {
					s.failed[id] = version;
				});
				throw error;
			}
			// The npm package supersedes any signed-feed receipt for this connector.
			await this.store.mutate((s) => {
				s.installations = s.installations.filter((i) => i.id !== id);
				delete s.failed[id];
			});
		} finally {
			unlock?.();
			this.active = false;
		}
	}
	/**
	 * Moves catalog connectors still running a legacy MCPB bundle to their npm package, keeping
	 * their settings and server ID. Runs at startup and after update checks regardless of the
	 * automatic-update preference, because bundle distribution has ended; a pinned connector is
	 * left alone, and a failed migration is retried only manually.
	 */
	async migrate(signal = new AbortController().signal) {
		if (!this.host.npm) return [];
		return this.exclusive(async () => {
			const results: Array<{ id: string; error?: string }> = [];
			const policy = await this.policy.read();
			for (const target of await this.npmTargets()) {
				if (!target.legacy || policy.pins[updateInstanceKey(this.host.root, target.id)])
					continue;
				try {
					let state = await this.store.read();
					if (!state.npm[target.id]) {
						await this.checkNpmLocked(signal);
						state = await this.store.read();
					}
					const version = this.npmCandidate(target, state);
					if (!version || state.failed[target.id] === version) continue;
					await this.transfer(target.id, signal, false, (signal) =>
						this.applyNpmLocked(target, false, signal),
					);
					results.push({ id: target.id });
				} catch (error) {
					results.push({
						id: target.id,
						error: error instanceof Error ? error.message : "Migration failed.",
					});
				}
			}
			return results;
		});
	}
	async recover() {
		return this.exclusive(() => this.recoverLocked());
	}
	/**
	 * A launch argument that still points at a published file of an earlier version's directory,
	 * mapped to the same file in the installed version. Desktop 0.1.36 left such entries behind
	 * when a Windows install recorded them with mixed separators.
	 */
	private staleArtifact(value: string, installed: Receipt) {
		if (!isAbsolute(value) || insidePath(value, installed.directory)) return undefined;
		if (samePath(value, installed.directory)) return undefined;
		const normalized = value.replace(/\\/g, "/");
		const file = installed.release.files
			.filter((f) => normalized.endsWith("/" + f.path))
			.sort((a, b) => b.path.length - a.path.length)[0];
		return file && join(installed.directory, file.path);
	}
	/** Best effort: re-point stale entries, never overriding a connection the user has edited. */
	private async repairStalePaths() {
		const state = await this.store.read();
		for (const installed of state.installations) {
			const config = installed.config;
			if (config.transport !== "stdio" || config.managedBrowser) continue;
			const args = config.args.map((arg) => this.staleArtifact(arg, installed) ?? arg);
			if (args.every((arg, i) => arg === config.args[i])) continue;
			const current = (await this.host.configurations()).find((c) => c.id === installed.id);
			if (JSON.stringify(current) !== JSON.stringify(config)) continue;
			const unlock = await this.host.maintenance(installed.id).catch(() => undefined);
			if (!unlock) continue;
			try {
				const repaired = { ...structuredClone(config), args, generation: randomUUID() };
				await this.host.replace(repaired, current);
				await this.store.mutate((s) => {
					const item = s.installations.find((i) => i.id === installed.id);
					if (item) item.config = repaired;
				});
			} catch {
				/* Retried on the next recovery pass. */
			} finally {
				unlock();
			}
		}
	}
	private async recoverLocked() {
		await recoverUpdateCoordination(this.host.root);
		await this.repairStalePaths();
		const state = await this.store.read();
		if (!state.journal) return;
		const { previous, candidate } = state.journal;
		const current = (await this.host.configurations()).find((c) => c.id === previous.id);
		if (
			![JSON.stringify(previous.config), JSON.stringify(candidate.config)].includes(
				JSON.stringify(current),
			)
		)
			throw Error("Connector changed during recovery; preserved for manual review");
		const unlock = await this.host.maintenance(previous.id);
		if (!unlock) throw Error("Connector recovery deferred until idle");
		try {
			await this.host.replace(previous.config, current);
			await this.store.mutate((s) => {
				delete s.journal;
				s.failed[previous.id] = candidate.release.version;
			});
		} finally {
			unlock();
		}
	}
}
