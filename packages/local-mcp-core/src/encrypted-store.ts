import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { z } from "zod";

import { systemEntry, type EntryFactory } from "./store";

/** Single-owner encrypted document storage. The helper owns all mutations. */
export class EncryptedStore<T> {
	private mutations: Promise<unknown> = Promise.resolve();
	readonly entries: EntryFactory;
	constructor(
		readonly root: string,
		readonly name: string,
		private schema: z.ZodType<T>,
		private initial: () => T,
		entries?: EntryFactory,
	) {
		if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid encrypted document name");
		this.entries = entries ?? ((key) => systemEntry(root, key));
	}
	private async key(create: boolean) {
		const entry = await this.entries(`${this.name}:key`);
		let value = entry.getPassword();
		if (!value && create) {
			value = randomBytes(32).toString("base64");
			entry.setPassword(value);
		}
		if (!value || Buffer.from(value, "base64").length !== 32)
			throw new Error("Unlock your system keychain to open Laplace Desktop");
		return Buffer.from(value, "base64");
	}
	async read(): Promise<T> {
		let bytes: Buffer;
		try {
			bytes = await readFile(join(this.root, `${this.name}.enc`));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return this.schema.parse(this.initial());
			throw error;
		}
		try {
			if (bytes.subarray(0, 4).toString() !== "LDE1") throw new Error();
			const decipher = createDecipheriv(
				"aes-256-gcm",
				await this.key(false),
				bytes.subarray(4, 16),
			);
			decipher.setAAD(Buffer.from(`laplace-desktop/${this.name}/v1`));
			decipher.setAuthTag(bytes.subarray(16, 32));
			return this.schema.parse(
				JSON.parse(
					Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString("utf8"),
				),
			);
		} catch {
			throw new Error("Cannot decrypt desktop state. Restore or unlock your system keychain.");
		}
	}
	mutate(work: (value: T) => void | Promise<void>): Promise<T> {
		const task = this.mutations
			.catch(() => {})
			.then(async () => {
				const value = await this.read();
				await work(value);
				const valid = this.schema.parse(value);
				const iv = randomBytes(12),
					cipher = createCipheriv("aes-256-gcm", await this.key(true), iv);
				cipher.setAAD(Buffer.from(`laplace-desktop/${this.name}/v1`));
				const ciphertext = Buffer.concat([cipher.update(JSON.stringify(valid)), cipher.final()]);
				await mkdir(this.root, { recursive: true, mode: 0o700 });
				const temporary = join(this.root, `${this.name}.${randomUUID()}.tmp`);
				try {
					await writeFile(
						temporary,
						Buffer.concat([Buffer.from("LDE1"), iv, cipher.getAuthTag(), ciphertext]),
						{ mode: 0o600, flag: "wx" },
					);
					await rename(temporary, join(this.root, `${this.name}.enc`));
				} finally {
					await rm(temporary, { force: true });
				}
				return valid;
			});
		this.mutations = task;
		return task;
	}
}
