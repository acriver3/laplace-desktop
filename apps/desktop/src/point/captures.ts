import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, lstat, rename } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { pointDestination, type PointCapture, type PointTarget } from "../shared/point-contracts";

export const retentionMs = 7 * 24 * 60 * 60 * 1000;
const record = z
	.object({
		id: z.string().uuid(),
		destination: pointDestination.optional(),
		token: z.string().regex(/^[a-f0-9]{64}$/),
		createdAt: z.number().finite(),
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		target: z
			.object({
				window: z.string(),
				pid: z.number().int(),
				version: z.string(),
				chatLink: z.string(),
			})
			.optional(),
		attachmentAttempted: z.boolean().optional(),
		annotationAttempted: z.boolean().optional(),
		handoffComplete: z.boolean().optional(),
	})
	.strict();
export type StoredCapture = PointCapture & { token: string };

export class PointCaptures {
	readonly items = new Map<string, StoredCapture>();
	constructor(
		readonly root: string,
		private readonly now = Date.now,
	) {}
	file(id: string) {
		return join(this.root, `${z.string().uuid().parse(id)}.png`);
	}
	private metadata(id: string) {
		return join(this.root, `${z.string().uuid().parse(id)}.json`);
	}
	async initialize() {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		for (const name of await readdir(this.root)) {
			if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
			try {
				const file = join(this.root, name);
				const info = await lstat(file);
				if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) continue;
				const item = record.parse(JSON.parse(await readFile(file, "utf8")));
				if (name !== `${item.id}.json`) continue;
				const image = await lstat(this.file(item.id));
				if (image.isFile() && !image.isSymbolicLink()) this.items.set(item.id, item);
			} catch {
				/* Ignore incomplete records; cleanup below removes owned orphan files. */
			}
		}
		await this.prune(false, true);
	}
	async save(png: Buffer, size: { width: number; height: number }, target?: PointTarget) {
		const item: StoredCapture = {
			id: randomUUID(),
			token: randomBytes(32).toString("hex"),
			createdAt: this.now(),
			...size,
			...(target ? { target } : {}),
		};
		record.parse(item);
		await writeFile(this.file(item.id), png, { mode: 0o600, flag: "wx" });
		await writeFile(this.metadata(item.id), JSON.stringify(item), { mode: 0o600, flag: "wx" });
		this.items.set(item.id, item);
		return item;
	}
	async update(item: StoredCapture) {
		if (!this.items.has(item.id)) throw new Error("The snip has expired.");
		const temporary = join(this.root, `${randomUUID()}.pending`);
		try {
			await writeFile(temporary, JSON.stringify(record.parse(item)), { mode: 0o600, flag: "wx" });
			await rename(temporary, this.metadata(item.id));
		} finally {
			await rm(temporary, { force: true });
		}
		this.items.set(item.id, item);
	}
	byToken(token: string) {
		return [...this.items.values()].find(
			(item) => item.token === token && this.now() - item.createdAt < retentionMs,
		);
	}
	async read(item: StoredCapture) {
		const path = this.file(item.id);
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024)
			throw new Error("Snip unavailable.");
		return readFile(path);
	}
	async prune(clear = false, collectOrphans = false) {
		for (const [id, item] of this.items) {
			if (clear || this.now() - item.createdAt >= retentionMs || item.createdAt > this.now()) {
				this.items.delete(id);
				await rm(this.metadata(id), { force: true });
				await rm(this.file(id), { force: true });
			}
		}
		if (!clear && !collectOrphans) return;
		for (const name of await readdir(this.root)) {
			if (/^[a-f0-9-]{36}\.pending$/.test(name)) {
				await rm(join(this.root, name), { force: true });
				continue;
			}
			if (/^[a-f0-9-]{36}\.(png|json)$/.test(name) && !this.items.has(name.slice(0, 36)))
				await rm(join(this.root, name), { force: true });
		}
	}
}
