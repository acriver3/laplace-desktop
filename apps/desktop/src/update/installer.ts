import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import {
	assertDestination,
	executable,
	exists,
	installationSchema,
	lock,
	packageDigest,
	readJson,
	requireAppClosed,
	revisionSchema,
	toolEnvironment,
	updateRoot,
	versionSchema,
	writeJson,
	run,
	runtimePath,
	type Installation,
} from "./common";
import { cp, lstat, rename, rm, readdir, mkdir, copyFile, writeFile } from "./filesystem";

export const pendingSchema = z
	.object({
		id: z.string().uuid(),
		installationId: z.string().uuid(),
		version: versionSchema,
		commit: revisionSchema,
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export type PendingUpdate = z.infer<typeof pendingSchema>;
const journalSchema = z
	.object({
		previous: installationSchema,
		next: pendingSchema,
		phase: z.enum(["prepared", "replacing", "launching", "accepted", "rolled-back"]),
	})
	.strict();
export const stagedPackage = (root: string, id: string) =>
	join(root, "staging", z.string().uuid().parse(id), "package");
const installationDirectory = (installation: Installation) =>
	installation.distribution === "squirrel" ? dirname(installation.path) : installation.path;
export const backupPath = (installation: Installation) =>
	join(
		dirname(installationDirectory(installation)),
		`.${basename(installationDirectory(installation))}.previous-${installation.id}`,
	);
const incomingPath = (installation: Installation, id: string) =>
	join(dirname(installation.path), `.${basename(installation.path)}.incoming-${id}`);
export const healthPath = (root: string, id: string) =>
	join(root, `healthy-${z.string().uuid().parse(id)}.json`);

export async function validatePending(root: string, installation: Installation) {
	const next = pendingSchema.parse(await readJson(join(root, "pending.json")));
	if (next.installationId !== installation.id)
		throw new Error("Update belongs to another installation.");
	const staged = stagedPackage(root, next.id);
	if ((await lstat(staged)).isSymbolicLink() || (await packageDigest(staged)) !== next.digest)
		throw new Error("The staged application changed. Download the update again.");
	return next;
}

/** Dependencies make failure and power-loss recovery testable without replacing an actual app. */
export interface InstallerHost {
	launch(
		this: void,
		path: string,
		target: string,
		nonce?: string,
	): Promise<{ stop(): Promise<void> }>;
	waitForHealth(this: void, root: string, next: PendingUpdate): Promise<void>;
}
export const nativeInstallerHost: InstallerHost = {
	async launch(path, target, nonce) {
		const child = spawn(
			executable(path, target),
			nonce ? [`--laplace-update-accept=${nonce}`] : [],
			{ detached: true, stdio: "ignore", env: toolEnvironment(), windowsHide: true },
		);
		await new Promise<void>((done, fail) => {
			child.once("spawn", done);
			child.once("error", fail);
		});
		child.unref();
		return {
			async stop() {
				child.kill();
				for (
					let attempt = 0;
					attempt < 50 && child.exitCode === null && child.signalCode === null;
					attempt++
				)
					await delay(100);
				if (child.exitCode === null && child.signalCode === null)
					throw new Error("Updated app did not stop. Close it before recovery.");
			},
		};
	},
	async waitForHealth(root, next) {
		for (let attempt = 0; attempt < 120; attempt++) {
			try {
				const value = (await readJson(healthPath(root, next.id))) as {
					version?: string;
					commit?: string;
				};
				if (value.version === next.version && value.commit === next.commit) return;
			} catch {
				/* Wait for the new main process and helper to initialize. */
			}
			await delay(500);
		}
		throw new Error("The updated app did not finish starting.");
	},
};

export async function recoverInstallation(root: string, host: InstallerHost = nativeInstallerHost) {
	const journalPath = join(root, "journal.json");
	if (!(await exists(journalPath))) return;
	const journal = journalSchema.parse(await readJson(journalPath)),
		old = journal.previous;
	assertDestination(old.path);
	if (host === nativeInstallerHost && journal.phase !== "accepted")
		await requireAppClosed(old.path, old.target);
	if (journal.phase === "accepted") {
		await writeJson(join(root, "installation.json"), {
			...old,
			path:
				old.distribution === "squirrel"
					? join(dirname(old.path), `app-${journal.next.version}`)
					: old.path,
			version: journal.next.version,
			commit: journal.next.commit,
		});
	} else if (journal.phase !== "rolled-back") {
		const backup = backupPath(old),
			destination = installationDirectory(old);
		if (await exists(backup)) {
			// Retain a failed candidate for diagnosis, but never overwrite the previous app.
			if (await exists(destination))
				await rename(destination, destination + ".failed-" + journal.next.id);
			await rename(backup, destination);
		} else if (!(await exists(old.path)))
			throw new Error("The previous application is missing. Re-run source installation.");
		await writeJson(join(root, "installation.json"), old);
		await writeJson(join(root, "last-result.json"), {
			ok: false,
			message:
				"The previous app was restored after an interrupted or unsuccessful update. Download again to retry.",
		});
		await writeJson(journalPath, { ...journal, phase: "rolled-back" });
		await host.launch(old.path, old.target);
	}
	await rm(join(root, "pending.json"), { force: true });
	await rm(journalPath, { force: true });
}

export async function installPrepared(
	root: string,
	installation: Installation,
	host: InstallerHost = nativeInstallerHost,
) {
	await writeJson(join(root, "installing.json"), {
		pid: process.pid,
		executable: executable(installation.path, installation.target),
	});
	try {
		await replacePrepared(root, installation, host);
	} finally {
		await rm(join(root, "installing.json"), { force: true });
	}
}

async function replacePrepared(
	root: string,
	installation: Installation,
	host: InstallerHost = nativeInstallerHost,
) {
	assertDestination(installation.path);
	if (host === nativeInstallerHost) await requireAppClosed(installation.path, installation.target);
	const next = await validatePending(root, installation);
	if (installation.distribution === "squirrel")
		return installSquirrel(root, installation, next, host);
	const incoming = incomingPath(installation, next.id),
		backup = backupPath(installation);
	if (await exists(join(root, "journal.json")))
		throw new Error("Recover the interrupted installation before retrying.");
	await rm(incoming, { recursive: true, force: true });
	await cp(stagedPackage(root, next.id), incoming, { recursive: true, verbatimSymlinks: true });
	if ((await packageDigest(incoming)) !== next.digest)
		throw new Error("The copied application failed integrity verification.");
	await rm(backup, { recursive: true, force: true });
	const journal = { previous: installation, next, phase: "prepared" as string };
	await writeJson(join(root, "journal.json"), journal);
	let launched: Awaited<ReturnType<InstallerHost["launch"]>> | undefined;
	try {
		await writeJson(join(root, "journal.json"), { ...journal, phase: "replacing" });
		await rename(installation.path, backup);
		await rename(incoming, installation.path);
		await writeJson(join(root, "journal.json"), { ...journal, phase: "launching" });
		launched = await host.launch(installation.path, installation.target, next.id);
		await host.waitForHealth(root, next);
		await writeJson(join(root, "journal.json"), { ...journal, phase: "accepted" });
	} catch (error) {
		await launched?.stop();
		await recoverInstallation(root, host);
		throw error;
	}

	await writeJson(join(root, "installation.json"), {
		...installation,
		version: next.version,
		commit: next.commit,
	});
	await writeJson(join(root, "last-result.json"), {
		ok: true,
		message: `Updated to ${next.version}.`,
	});
	await rm(join(root, "pending.json"), { force: true });
	await rm(join(root, "journal.json"), { force: true });
}

async function installSquirrel(
	root: string,
	installation: Installation,
	next: PendingUpdate,
	host: InstallerHost,
) {
	const directory = dirname(installation.path),
		backup = backupPath(installation);
	const destination = join(directory, `app-${next.version}`);
	assertDestination(destination);
	if (await exists(join(root, "journal.json"))) throw Error("Recover the interrupted update first");
	await rm(backup, { recursive: true, force: true });
	await cp(directory, backup, { recursive: true, verbatimSymlinks: true });
	const previousDigest = await packageDigest(directory);
	if ((await packageDigest(backup)) !== previousDigest)
		throw Error("Squirrel recovery copy failed integrity verification");
	await writeJson(join(root, "journal.json"), { previous: installation, next, phase: "prepared" });
	let launched: Awaited<ReturnType<InstallerHost["launch"]>> | undefined;
	try {
		await writeJson(join(root, "journal.json"), {
			previous: installation,
			next,
			phase: "replacing",
		});
		// Squirrel receives a local feed containing only bytes checked against the signed release.
		await run(
			join(directory, "Update.exe"),
			["--update", join(stagedPackage(root, next.id), ".laplace-squirrel")],
			{ timeout: 600000 },
		);
		await writeJson(join(root, "journal.json"), {
			previous: installation,
			next,
			phase: "launching",
		});
		await preserveSquirrelLaunchers(directory, backup, destination);
		launched = await host.launch(destination, installation.target, next.id);
		await host.waitForHealth(root, next);
		await writeJson(join(root, "journal.json"), {
			previous: installation,
			next,
			phase: "accepted",
		});
		await writeJson(join(root, "installation.json"), {
			...installation,
			path: destination,
			version: next.version,
			commit: next.commit,
		});
		await writeJson(join(root, "last-result.json"), {
			ok: true,
			message: `Updated to ${next.version}.`,
		});
		await rm(join(root, "pending.json"), { force: true });
		await rm(join(root, "journal.json"), { force: true });
	} catch (error) {
		await launched?.stop();
		await recoverInstallation(root, host);
		throw error;
	}
}

export async function applyFromHandoff(parentPid: number, nonce: string) {
	const root = updateRoot(),
		release = await lock(root);
	let exited = false;
	try {
		const installation = installationSchema.parse(await readJson(join(root, "installation.json")));
		assertDestination(installation.path);
		const pending = await validatePending(root, installation);
		if (pending.id !== nonce) throw new Error("Update handoff changed.");
		await writeJson(join(root, "installing.json"), {
			pid: process.pid,
			executable: executable(installation.path, installation.target),
		});
		await writeJson(join(root, `handoff-${pending.id}.json`), { ready: true });
		for (let attempt = 0; attempt < 120; attempt++) {
			try {
				process.kill(parentPid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					exited = true;
					break;
				}
			}
			await delay(500);
		}
		if (!exited) throw new Error("Laplace did not finish quitting. Retry the update.");
		await installPrepared(root, installation);
	} catch {
		await writeJson(join(root, "last-result.json"), {
			ok: false,
			message:
				"The update could not be installed. Close AI clients that may be using Laplace files, then retry. Run source setup --recover if Laplace cannot open.",
		});
		if (exited && !(await exists(join(root, "journal.json")))) {
			try {
				const previous = installationSchema.parse(await readJson(join(root, "installation.json")));
				await requireAppClosed(previous.path, previous.target);
				await nativeInstallerHost.launch(previous.path, previous.target);
			} catch {
				/* Recovery instructions remain available in the source installer. */
			}
		}
	} finally {
		await rm(join(root, "installing.json"), { force: true });
		await release();
	}
}

export async function acknowledgeUpdate(nonce: string, version: string, root = updateRoot()) {
	const journal = journalSchema.parse(await readJson(join(root, "journal.json")));
	if (
		journal.next.id !== nonce ||
		journal.next.version !== version ||
		journal.phase !== "launching"
	)
		throw new Error("Unexpected update startup receipt.");
	await writeJson(healthPath(root, nonce), { version, commit: journal.next.commit });
}

export async function preserveSquirrelLaunchers(
	directory: string,
	backup: string,
	destination: string,
) {
	// Keep historical assistant registrations usable when Squirrel removes app-* directories.
	// Launch recipes are local constants; signed release metadata supplies no commands.
	for (const name of await readdir(backup)) {
		if (!/^app-\d+\.\d+\.\d+$/.test(name) || name === basename(destination)) continue;
		const oldResources = runtimePath(join(directory, name), "win32-x64");
		const oldNode = join(oldResources, "runtimes", "node.exe");
		await mkdir(join(oldResources, "runtimes"), { recursive: true });
		await mkdir(join(oldResources, "helper"), { recursive: true });
		if (!(await exists(oldNode)))
			await copyFile(join(runtimePath(destination, "win32-x64"), "runtimes", "node.exe"), oldNode);
		const node = join(runtimePath(destination, "win32-x64"), "runtimes", "node.exe");
		const bridge = join(runtimePath(destination, "win32-x64"), "helper", "bridge.cjs");
		await writeFile(
			join(oldResources, "helper", "bridge.cjs"),
			`const {spawn}=require('node:child_process'); const child=spawn(${JSON.stringify(node)},[${JSON.stringify(bridge)},...process.argv.slice(2)],{stdio:'inherit',windowsHide:true}); child.on('error',()=>process.exit(1)); child.on('exit',code=>process.exit(code??1)); for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));`,
			{ mode: 0o600 },
		);
	}
}
