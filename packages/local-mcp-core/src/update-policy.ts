import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

export const updatePolicySchema = z
	.object({
		version: z.literal(1).default(1),
		desktop: z.boolean().default(false),
		connectors: z.boolean().default(false),
		deferredUntil: z.number().finite().nonnegative().default(0),
		pins: z.record(z.string(), z.boolean()).default({}),
	})
	.strict();
export type UpdatePolicy = z.infer<typeof updatePolicySchema>;
export const updatePolicyRoot = () => join(homedir(), ".laplace", "updates");
export const updateInstanceKey = (root: string, id: string) =>
	createHash("sha256")
		.update(resolve(root) + "\0" + id)
		.digest("hex");
export const automaticUpdatesEnabled = () => process.env.LAPLACE_AUTOMATIC_UPDATES_V1 === "true";

/** Shared per-user preferences; no credentials or executable paths are stored here. */
export class UpdatePolicyStore {
	constructor(readonly root = updatePolicyRoot()) {}
	async read(): Promise<UpdatePolicy> {
		try {
			return updatePolicySchema.parse(
				JSON.parse(await readFile(join(this.root, "preferences.json"), "utf8")),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return updatePolicySchema.parse({});
			throw new Error(
				"Update preferences are unreadable; automatic updates are disabled until repaired.",
			);
		}
	}
	async mutate(work: (policy: UpdatePolicy) => void): Promise<UpdatePolicy> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const lock = join(this.root, "preferences.lock");
		try {
			await mkdir(lock, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const pid = Number(await readFile(join(lock, "pid"), "utf8").catch(() => "0"));
			if (!Number.isSafeInteger(pid) || pid < 1)
				throw Error(
					"Update preferences lock needs recovery after confirming no updater is running.",
				);
			try {
				process.kill(pid, 0);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
					const recovery = join(lock, "recovery");
					await mkdir(recovery);
					try {
						if (Number(await readFile(join(lock, "pid"), "utf8")) !== pid)
							throw Error("Update lock ownership changed; retry.");
						await rm(lock, { recursive: true });
					} finally {
						await rm(recovery, { recursive: true, force: true });
					}
					return this.mutate(work);
				}
				throw cause;
			}
			throw Error(
				"Update preferences are locked. Retry after the other update operation completes.",
			);
		}
		await writeFile(join(lock, "pid"), String(process.pid), { mode: 0o600, flag: "wx" });
		const temporary = join(this.root, randomUUID() + ".tmp");
		try {
			const policy = await this.read();
			work(policy);
			const valid = updatePolicySchema.parse(policy);
			await writeFile(temporary, JSON.stringify(valid), { mode: 0o600, flag: "wx" });
			await rename(temporary, join(this.root, "preferences.json"));
			return valid;
		} finally {
			await rm(temporary, { force: true });
			await rm(lock, { recursive: true });
		}
	}
}
