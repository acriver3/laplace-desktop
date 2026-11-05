import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, lstat, readdir, statfs } from "node:fs/promises";
import { join, resolve, sep, basename, dirname } from "node:path";
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
	journal: journal.optional(),
	failed: z.record(z.string(), z.string()).default({}),
	proof: z.object({ payload: z.string(), signature: z.string() }).optional(),
	index: connectorIndex.optional(),
});
type Receipt = z.infer<typeof receipt>;
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
}
export interface ConnectorUpdateStatus {
	id: string;
	version: string;
	availableVersion?: string;
	pinned: boolean;
	message?: string;
	name?: string;
	phase?: "downloading" | "installing" | "idle";
}
const feed =
	"https://raw.githubusercontent.com/acriver3/laplace-mcp-library/main/updates/stable.json";
export { connectorSigningKey } from "./connector-releases";
export class ConnectorUpdates {
	private store: EncryptedStore<z.infer<typeof document>>;
	private active = false;
	private transfers = new Map<string, AbortController>();
	private installing = new Set<string>();
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
			throw Error("Another connector updater owns this installation; retry after it completes.");
		}
		await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600, flag: "wx" });
		try {
			return await work();
		} finally {
			await rm(path, { recursive: true });
		}
	}
	async check(signal = new AbortController().signal) {
		return this.exclusive(() => this.checkLocked(signal));
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
			state.proof = { payload: bytes.toString("base64"), signature: signature.toString("base64") };
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
		const [state, policy] = await Promise.all([this.store.read(), this.policy.read()]);
		return state.installations.map((installed) => {
			const candidate = this.candidate(installed, state.index);
			return {
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
				message:
					state.journal?.previous.id === installed.id
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
		const walk = async (relative = "") => {
			for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
				const path = relative ? relative + "/" + entry.name : entry.name;
				if (entry.isSymbolicLink()) throw Error("Linked connector file rejected");
				if (entry.isDirectory()) await walk(path);
				else if (
					!expected.has(path) &&
					![".laplace-release.json", ".laplace-retained.json", ".laplace-bundle.json"].includes(
						path,
					)
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
				if ((await lstat(current)).isSymbolicLink()) throw Error("Linked connector file rejected");
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
		const nodeCommand =
			config.command === "node" ||
			config.command === "node.exe" ||
			release.files.some(
				(file) =>
					file.executable &&
					join(source, file.path) === launch.command &&
					/^(node|node.exe)$/i.test(basename(file.path)),
			);
		const nodeRecipe =
			nodeCommand &&
			!!entry &&
			release.files.some(
				(file) => join(source, file.path) === entry && /\.(mjs|cjs|js)$/.test(file.path),
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
			config.command === "uv" &&
			uvPrefix.every((value, i) => launch.args[i] === value);
		if (!nodeRecipe && !uvRecipe)
			throw Error(
				"Enrollment requires a maintained local launch recipe and the exact published entry; custom executables remain unmanaged.",
			);
		if (
			!config.args.some((arg) => arg.startsWith(source + sep)) &&
			config.cwd !== source &&
			!config.command.startsWith(source + sep)
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
				if (retained.transport !== "stdio") throw Error("Invalid retained connector transport");
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
				let bytes = await boundedDownload(
					url,
					file.compressed?.size ?? file.size,
					signal,
					this.fetcher,
				);
				if (file.compressed) {
					if (bytes.length !== file.compressed.size || sha256(bytes) !== file.compressed.sha256)
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
		const replace = (value: string) =>
			value === installed.directory
				? directory
				: value.startsWith(installed.directory + sep)
					? directory + value.slice(installed.directory.length)
					: value;
		config.command = replace(config.command);
		config.args = config.args.map(replace);
		if (config.cwd) config.cwd = replace(config.cwd);
		// Only rebase environment references to verified artifact files. Profile,
		// credential and other mutable data paths must retain their original location.
		const artifactPaths = new Set(
			installed.release.files.map((file) => join(installed.directory, file.path)),
		);
		config.env = Object.fromEntries(
			Object.entries(config.env).map(([key, value]) => [
				key,
				artifactPaths.has(value) ? replace(value) : value,
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
				const state = await this.store.read(),
					installed = state.installations.find((i) => i.id === id);
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
	private async applyLocked(id: string, automatic: boolean, signal: AbortSignal, retain: boolean) {
		if (automatic && !automaticUpdatesEnabled()) throw Error("Automatic updates are not activated");
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
			if (automatic && ((await (this.host.idleSeconds?.() ?? computerIdleSeconds())) ?? -1) < 900)
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
				throw Error("Connector configuration changed; enroll its reviewed configuration again");
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
					throw Error("This connector adds tools that require explicit permission review.");
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
					throw Error("Connector changed during update; recovery journal retained for review.");
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
	async recover() {
		return this.exclusive(() => this.recoverLocked());
	}
	private async recoverLocked() {
		await recoverUpdateCoordination(this.host.root);
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
