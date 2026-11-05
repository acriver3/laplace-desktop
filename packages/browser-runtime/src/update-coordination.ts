import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const sharedBrowserUpdateRoot = () =>
	join(homedir(), ".laplace", "browser", "update-owners");

/** Cooperative maintenance across Desktop, CLI transports, and shared runtime owners. */
export class UpdateCoordination {
	private id = `${process.pid}-${randomUUID()}`;
	private directory: string;
	private marker: string;
	private timer?: ReturnType<typeof setInterval>;
	private release?: () => void;
	private polling = false;
	private resuming = false;
	private own = false;
	private stopping = false;
	private cleaning?: Promise<void>;
	private ownerRelease?: () => void;
	constructor(
		root: string,
		private busy: () => boolean,
		private pause: () => (() => void) | undefined,
		private reload: () => Promise<void>,
	) {
		this.directory = join(root, "update-participants");
		this.marker = join(root, "update-maintenance");
	}
	get active() {
		return this.own || this.blocked;
	}
	get blocked() {
		return !this.own && (this.resuming || !!this.release || existsSync(this.marker));
	}
	async start() {
		if (this.timer) return;
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await writeFile(
			join(this.directory, this.id),
			JSON.stringify({ pid: process.pid, protocol: 1 }),
			{
				flag: "wx",
				mode: 0o600,
			},
		);
		await recoverUpdateCoordination(this.directory + "/..").catch(() => {});
		this.timer = setInterval(() => {
			void this.poll().catch(() => {});
		}, 250);
		this.timer.unref();
	}
	private async poll() {
		if (this.polling || this.own || this.stopping) return;
		this.polling = true;
		try {
			if (existsSync(this.marker)) {
				const marker = JSON.parse(await readFile(join(this.marker, "owner.json"), "utf8"));
				if (!this.release && !this.busy()) this.release = this.pause();
				if (this.release)
					await writeFile(join(this.marker, this.id), marker.nonce, { mode: 0o600 });
			} else if (this.release) {
				this.resuming = true;
				try {
					this.release();
					this.release = undefined;
					await this.reload();
				} finally {
					this.resuming = false;
				}
			}
		} finally {
			this.polling = false;
		}
	}
	async acquire(localPause: () => (() => void) | undefined) {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		if (this.cleaning || this.busy() || this.stopping) return;
		try {
			await mkdir(this.marker, { mode: 0o700 });
		} catch {
			return;
		}
		this.own = true;
		const nonce = randomUUID();
		let localRelease: (() => void) | undefined;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			localRelease?.();
			this.own = false;
			this.ownerRelease = undefined;
			this.cleaning = rm(this.marker, { recursive: true, force: true })
				.catch(() => {})
				.finally(() => {
					this.cleaning = undefined;
				});
		};
		try {
			await writeFile(
				join(this.marker, "owner.json"),
				JSON.stringify({ pid: process.pid, nonce }),
				{ mode: 0o600 },
			);
			localRelease = localPause();
			if (!localRelease) {
				release();
				return;
			}
			for (let attempt = 0; attempt < 12; attempt++) {
				let ready = true;
				for (const name of await readdir(this.directory).catch(() => [])) {
					if (name === this.id) continue;
					const peer = JSON.parse(await readFile(join(this.directory, name), "utf8"));
					if (!Number.isSafeInteger(peer.pid) || peer.pid < 1)
						throw Error("Invalid updater participant");
					try {
						process.kill(peer.pid, 0);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ESRCH") {
							await rm(join(this.directory, name), { force: true });
							continue;
						}
						throw error;
					}
					if (peer.protocol !== 1)
						throw Error(
							"Another Laplace owner requires a compatible host update before shared maintenance.",
						);
					const ack = await readFile(join(this.marker, name), "utf8").catch(() => "");
					if (ack !== nonce) ready = false;
				}
				if (ready) {
					this.ownerRelease = release;
					return release;
				}
				await delay(250);
			}
			release();
			return;
		} catch (error) {
			release();
			throw error;
		}
	}
	async stop() {
		this.stopping = true;
		clearInterval(this.timer);
		while (this.polling) await delay(10);
		this.release?.();
		this.ownerRelease?.();
		await this.cleaning;
		await rm(join(this.directory, this.id), { force: true });
	}
}

/** Caller must hold connector-update.lock, which serializes all maintenance owners. */
export async function recoverUpdateCoordination(root: string) {
	const marker = join(root, "update-maintenance");
	let owner: { pid: number };
	try {
		owner = JSON.parse(await readFile(join(marker, "owner.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(marker)) return;
		throw Error("Incomplete maintenance record requires local inspection.");
	}
	if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error("Invalid maintenance owner");
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		const guard = join(marker, "recovery");
		await mkdir(guard);
		try {
			const current = JSON.parse(await readFile(join(marker, "owner.json"), "utf8"));
			if (current.pid !== owner.pid) throw Error("Maintenance owner changed");
			await rm(marker, { recursive: true });
		} finally {
			await rm(guard, { recursive: true, force: true });
		}
		return;
	}
	throw Error("Another updater still owns maintenance; retry after it finishes.");
}
