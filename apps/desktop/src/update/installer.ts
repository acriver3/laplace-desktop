import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { cp, lstat, rename, rm } from "./filesystem";

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
	type Installation,
} from "./common";

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
export const backupPath = (installation: Installation) =>
	join(dirname(installation.path), `.${basename(installation.path)}.previous-${installation.id}`);
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
			version: journal.next.version,
			commit: journal.next.commit,
		});
	} else if (journal.phase !== "rolled-back") {
		const backup = backupPath(old);
		if (await exists(backup)) {
			// Retain a failed candidate for diagnosis, but never overwrite the previous app.
			if (await exists(old.path))
				await rename(old.path, incomingPath(old, journal.next.id) + ".failed");
			await rename(backup, old.path);
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
