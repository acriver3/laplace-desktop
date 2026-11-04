import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import packageJson from "../../package.json";
import type { DesktopUpdateState } from "../shared/update-contracts";
import {
	executable,
	exists,
	lock,
	newer,
	packageDigest,
	readInstallation,
	readJson,
	repository,
	requireSpace,
	run,
	runtimePath,
	toolEnvironment,
	UpdateError,
	updateRoot,
	validateTools,
	writeJson,
	type Installation,
	type Release,
} from "./common";
import { stagedPackage, validatePending, type PendingUpdate } from "./installer";
import { checkPublicRelease } from "./release-manifest";

const { releaseSigningPublicKey } = packageJson as typeof packageJson & {
	releaseSigningPublicKey?: string;
};

export async function probePackage(
	path: string,
	target: string,
	version: string,
	root: string,
	signal?: AbortSignal,
) {
	const nonce = randomUUID(),
		profile = join(root, "probe", nonce);
	await mkdir(profile, { recursive: true, mode: 0o700 });
	const child = spawn(executable(path, target), [`--laplace-update-probe=${nonce}`], {
		env: { ...toolEnvironment(), LAPLACE_DESKTOP_TEST_ROOT: profile },
		stdio: "ignore",
		windowsHide: true,
	});
	let failed = false,
		passed = false;
	child.on("error", () => {
		failed = true;
	});
	try {
		for (let attempt = 0; attempt < 120; attempt++) {
			if (signal?.aborted) throw new UpdateError("cancelled", "Update cancelled.");
			try {
				const receipt = (await readJson(join(profile, "update-probe.json"))) as {
					nonce?: string;
					version?: string;
				};
				if (receipt.nonce === nonce && receipt.version === version) {
					passed = true;
					return;
				}
			} catch {
				/* Probe is still starting. */
			}
			if (failed || child.exitCode !== null)
				throw new UpdateError(
					"invalid",
					"The staged application could not start. The current installation is unchanged.",
				);
			await delay(500);
		}
		throw new UpdateError(
			"invalid",
			"The staged application did not become ready. Unlock the keychain and retry.",
		);
	} finally {
		if (passed)
			for (
				let attempt = 0;
				attempt < 150 && child.exitCode === null && child.signalCode === null;
				attempt++
			)
				await delay(100);
		child.kill();
		for (
			let attempt = 0;
			attempt < 50 && child.exitCode === null && child.signalCode === null;
			attempt++
		)
			await delay(100);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await cleanupProbeCredentials(path, target, profile);
		await rm(profile, { recursive: true, force: true });
	}
}

/** Only keys in this updater-created isolated profile are removed. */
export async function cleanupProbeCredentials(path: string, target: string, profile: string) {
	const ownedProfile = join(profile, "profiles", "hosted");
	// A read-only startup normally creates no credentials. In particular, do not
	// require an unlocked keychain merely to discard an empty verification profile.
	if (
		!(await exists(join(ownedProfile, "config.enc"))) &&
		!(await exists(join(ownedProfile, "desktop.enc")))
	)
		return;
	const runtime = runtimePath(path, target);
	const namespace = createHash("sha256")
		.update(resolve(profile, "profiles", "hosted"))
		.digest("hex");
	await run(
		join(runtime, "runtimes", target.startsWith("win32") ? "node.exe" : "node"),
		[
			"-e",
			"const {Entry}=require(process.argv[1]); for(const name of ['config-key','desktop:key']) { const entry=new Entry('laplace-local',process.argv[2]+':'+name,{linux:{store:'secret-service'}}); if(entry.getPassword()) entry.deletePassword(); }",
			join(runtime, "node_modules", "@napi-rs", "keyring"),
			namespace,
		],
		{
			message:
				"Could not clean up the isolated verification keychain entries. Retry after unlocking your keychain.",
		},
	);
}

export async function prepareSource(
	installation: Installation,
	release: Release,
	root: string,
	phase: (phase: DesktopUpdateState["phase"]) => void,
	signal?: AbortSignal,
) {
	await validateTools(installation);
	await requireSpace(root);
	const id = randomUUID(),
		directory = join(root, "staging", id),
		checkout = join(directory, "source");
	await mkdir(checkout, { recursive: true, mode: 0o700 });
	const git = (args: string[]) =>
		run(installation.git, args, {
			cwd: checkout,
			signal,
			authentication: true,
			timeout: 600_000,
			toolPath: installation.toolPath,
		});
	try {
		phase("downloading");
		await git(["init", "--quiet"]);
		await git([
			"-c",
			"core.hooksPath=",
			"fetch",
			"--depth=1",
			"--no-tags",
			"--",
			repository,
			`refs/tags/desktop-v${release.version}`,
		]);
		if ((await git(["rev-parse", "FETCH_HEAD^{commit}"])) !== release.commit)
			throw new UpdateError("invalid", "The release tag changed. Check for updates again.");
		await git(["-c", "core.hooksPath=", "checkout", "--detach", release.commit]);
		const pkg = (await readJson(join(checkout, "apps/desktop/package.json"))) as {
			version?: string;
			sourceUpdateProtocol?: number;
		};
		const workspace = (await readJson(join(checkout, "package.json"))) as {
			packageManager?: string;
		};
		if (
			pkg.version !== release.version ||
			pkg.sourceUpdateProtocol !== 1 ||
			workspace.packageManager !== "pnpm@10.28.2"
		)
			throw new UpdateError(
				"invalid",
				"This release requires a newer source installer. Run source setup from the released revision.",
			);
		phase("building");
		await run(installation.node, [installation.pnpm, "install", "--frozen-lockfile"], {
			cwd: checkout,
			toolPath: installation.toolPath,
			signal,
			timeout: 1_800_000,
		});
		await run(installation.node, [installation.pnpm, "--filter", "@repo/desktop", "package"], {
			cwd: checkout,
			toolPath: installation.toolPath,
			signal,
			timeout: 1_800_000,
		});
		phase("verifying");
		const output = join(
			checkout,
			"apps/desktop/out",
			`Laplace-${installation.target}`,
			...(installation.target.startsWith("darwin-") ? ["Laplace.app"] : []),
		);
		const candidate = stagedPackage(root, id);
		await cp(output, candidate, { recursive: true, verbatimSymlinks: true });
		await probePackage(candidate, installation.target, release.version, root, signal);
		const pending: PendingUpdate = {
			id,
			installationId: installation.id,
			version: release.version,
			commit: release.commit,
			digest: await packageDigest(candidate),
		};
		if (signal?.aborted) throw new UpdateError("cancelled", "Update cancelled.");
		await writeJson(join(root, "pending.json"), pending);
		await rm(checkout, { recursive: true, force: true });
		return pending;
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

export class SourceUpdater {
	state: DesktopUpdateState;
	private installation?: Installation;
	private available?: Release;
	private controller?: AbortController;
	private operation?: Promise<void>;
	private timers: ReturnType<typeof setTimeout>[] = [];
	constructor(
		private version: string,
		private currentExecutable: string,
		private publish: (state: DesktopUpdateState) => void,
		private root = updateRoot(),
	) {
		this.state = {
			phase: "unmanaged",
			installedVersion: version,
			message:
				"Run pnpm --filter @repo/desktop source:install from your clone to enable in-app updates.",
		};
	}
	private set(patch: Partial<DesktopUpdateState>) {
		this.state = { ...this.state, ...patch };
		this.publish(this.state);
	}
	async initialize() {
		if (!(await exists(join(this.root, "installation.json")))) {
			this.publish(this.state);
			return;
		}
		try {
			// Let the detached installer finish committing the startup receipt before
			// capturing the source identity used for the next update's rollback.
			for (
				let attempt = 0;
				attempt < 20 && (await exists(join(this.root, "journal.json")));
				attempt++
			)
				await delay(250);
			if (await exists(join(this.root, "journal.json")))
				throw new Error("An interrupted installation needs recovery.");
			const installation = await readInstallation(this.root);
			if (executable(installation.path, installation.target) !== this.currentExecutable) {
				this.publish(this.state);
				return;
			}
			this.installation = installation;
			this.set({ phase: "idle", message: undefined });
			if (await exists(join(this.root, "last-result.json"))) {
				const result = (await readJson(join(this.root, "last-result.json"))) as {
					ok?: boolean;
					message?: string;
				};
				this.set({
					phase: result.ok ? "idle" : "error",
					message: result.ok
						? "Update installed."
						: "The previous update did not complete. Retry, or run source:install --recover.",
				});
			}
			if (
				(await exists(join(this.root, "pending.json"))) &&
				!(await exists(join(this.root, "journal.json")))
			) {
				const next = await validatePending(this.root, installation);
				if (newer(next.version, this.version)) {
					this.available = next;
					this.set({
						phase: "ready",
						availableVersion: next.version,
						message: "Update built and verified. Restart when you’re ready.",
					});
				}
			}
			this.timers.push(setTimeout(() => void this.check(), 15_000));
			this.timers.push(setInterval(() => void this.check(), 6 * 60 * 60 * 1000));
		} catch {
			this.set({
				phase: "unmanaged",
				message: "Source update setup needs repair. Run source:install --recover from your clone.",
			});
		}
	}
	private async single(work: (signal: AbortSignal) => Promise<void>) {
		if (!this.installation || this.operation || this.state.phase === "installing") return;
		const controller = new AbortController();
		this.controller = controller;
		this.operation = (async () => {
			let release: (() => Promise<void>) | undefined;
			try {
				release = await lock(this.root);
				await work(controller.signal);
			} catch (error) {
				this.set({
					phase:
						error instanceof UpdateError && error.code === "cancelled"
							? this.available
								? "available"
								: "idle"
							: "error",
					message:
						error instanceof UpdateError
							? error.message
							: "The update could not complete. Retry, or run source setup to repair the installation.",
				});
			} finally {
				await release?.().catch(() => {
					this.set({
						phase: "error",
						message: "The update lock could not be cleared. Run source setup recovery.",
					});
				});
				this.controller = undefined;
				this.operation = undefined;
			}
		})();
		await this.operation;
	}
	async check() {
		if (this.state.phase === "ready") return;
		await this.single(async (signal) => {
			this.set({ phase: "checking", message: undefined });
			if (!releaseSigningPublicKey)
				throw new UpdateError("invalid", "This build has no trusted public update channel.");
			this.available = await checkPublicRelease(this.version, releaseSigningPublicKey, signal);
			this.set({
				phase: this.available ? "available" : "idle",
				availableVersion: this.available?.version,
				checkedAt: new Date().toISOString(),
				message: this.available ? undefined : "You’re up to date.",
			});
		});
	}
	async download() {
		if (!this.available || this.state.phase === "ready") return;
		await this.single(async (signal) => {
			this.set({ message: undefined });
			await prepareSource(
				this.installation!,
				this.available!,
				this.root,
				(phase) => this.set({ phase }),
				signal,
			);
			this.set({
				phase: "ready",
				message: "Update built and verified. Restart when you’re ready.",
			});
		});
	}
	async cancel() {
		this.controller?.abort();
		await this.operation;
	}
	async stop() {
		for (const timer of this.timers) clearTimeout(timer);
		await this.cancel();
	}
	async handoff() {
		if (this.state.phase !== "ready" || !this.installation || this.operation)
			throw new Error("No verified update is ready.");
		this.set({ phase: "installing", message: "Preparing to restart…" });
		try {
			const next = await validatePending(this.root, this.installation);
			const handoff = join(this.root, "handoff", next.id),
				runtime = runtimePath(this.installation.path, this.installation.target);
			await mkdir(handoff, { recursive: true, mode: 0o700 });
			const node = join(handoff, process.platform === "win32" ? "node.exe" : "node");
			await cp(join(runtime, "runtimes", process.platform === "win32" ? "node.exe" : "node"), node);
			await cp(join(runtime, "update", "cli.cjs"), join(handoff, "cli.cjs"));
			await rm(join(this.root, `handoff-${next.id}.json`), { force: true });
			const child = spawn(node, [join(handoff, "cli.cjs"), "apply", String(process.pid), next.id], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
				env: toolEnvironment(),
			});
			await new Promise<void>((done, fail) => {
				child.once("spawn", done);
				child.once("error", fail);
			});
			child.unref();
			for (let attempt = 0; attempt < 120; attempt++) {
				if (await exists(join(this.root, `handoff-${next.id}.json`))) return;
				await delay(500);
			}
			throw new Error("The installer did not become ready.");
		} catch {
			this.set({
				phase: "error",
				message: "Could not start the installer. Retry or run source setup recovery.",
			});
			throw new Error("Could not start the update installer.");
		}
	}
}
