import { createCipheriv, createDecipheriv, randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { connectorOriginSchema } from "@repo/project-protocol/local-mcp";
import { z } from "zod";

import { serverConfig } from "./config";

export interface SecretEntry {
	getPassword(): string | null;
	setPassword(value: string): void;
	deletePassword(): void;
}
export type EntryFactory = (name: string) => Promise<SecretEntry>;
export async function systemEntry(root: string, name: string): Promise<SecretEntry> {
	try {
		const { Entry } = await import("@napi-rs/keyring");
		return new Entry(
			"laplace-local",
			`${createHash("sha256").update(resolve(root)).digest("hex")}:${name}`,
			{ linux: { store: "secret-service" } },
		);
	} catch {
		throw new Error(
			"Persistent keychain unavailable. On Linux start/unlock a Secret Service provider; run doctor. No plaintext fallback is available.",
		);
	}
}
const stateSchema = z
	.object({
		servers: z.array(serverConfig).max(50).default([]),
		pendingRemovals: z.array(z.string()).max(50).optional(),
		pairing: z
			.object({
				origin: connectorOriginSchema,
				installationId: z.string().uuid(),
				accountId: z.string(),
			})
			.strict()
			.optional(),
		pending: z
			.object({
				origin: connectorOriginSchema,
				pollCode: z.string(),
				approvalCode: z.string(),
				verificationUrl: z.string().url(),
				expiresAt: z.number(),
			})
			.strict()
			.optional(),
	})
	.strict();
export type LocalState = z.infer<typeof stateSchema>;
interface SecretReference {
	id: string;
	field: "env" | "headers";
	key: string;
	name: string;
}
export class LocalStore {
	private references: SecretReference[] = [];
	constructor(
		readonly root: string,
		private entryFactory: EntryFactory = (name) => systemEntry(root, name),
	) {}
	async credential(value?: string) {
		const entry = await this.entryFactory("installation");
		if (value !== undefined) entry.setPassword(value);
		return entry.getPassword();
	}
	async clearCredential() {
		const e = await this.entryFactory("installation");
		try {
			e.deletePassword();
		} catch {
			if (e.getPassword()) throw new Error("Unable to remove keychain credential");
		}
	}
	private async key(create: boolean) {
		const entry = await this.entryFactory("config-key");
		let value = entry.getPassword();
		if (!value && create) {
			value = randomBytes(32).toString("base64");
			entry.setPassword(value);
		}
		if (!value || Buffer.from(value, "base64").length !== 32)
			throw new Error(
				"Encrypted configuration key unavailable; restore your keychain or repair locally.",
			);
		return Buffer.from(value, "base64");
	}
	async read(): Promise<LocalState> {
		let bytes: Buffer;
		try {
			bytes = await readFile(join(this.root, "config.enc"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.references = [];
				return { servers: [] };
			}
			throw error;
		}
		try {
			const key = await this.key(false);
			if (bytes.subarray(0, 4).toString() !== "LMC1") throw new Error();
			const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(4, 16));
			decipher.setAAD(Buffer.from("laplace-local/config/v1"));
			decipher.setAuthTag(bytes.subarray(16, 32));
			const payload = JSON.parse(
				Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString(),
			);
			const state = stateSchema.parse(payload.version === 2 ? payload.state : payload);
			this.references =
				payload.version === 2
					? z
							.array(
								z
									.object({
										id: z.string(),
										field: z.enum(["env", "headers"]),
										key: z.string(),
										name: z.string(),
									})
									.strict(),
							)
							.parse(payload.secrets)
					: [];
			for (const ref of this.references) {
				const server = state.servers.find((s) => s.id === ref.id);
				if (!server) throw new Error();
				const values = server.transport === "stdio" ? server.env : server.headers;
				if (
					(server.transport === "stdio" ? "env" : "headers") !== ref.field ||
					!(ref.key in values)
				)
					throw new Error();
				const value = (await this.entryFactory(ref.name)).getPassword();
				if (value === null) throw new Error();
				values[ref.key] = value;
			}
			return state;
		} catch {
			throw new Error(
				"Cannot decrypt local configuration. Check persistent keychain storage with doctor.",
			);
		}
	}
	async mutate(work: (state: LocalState) => Promise<void> | void) {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const lock = join(this.root, "config.lock");
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		const deadline = Date.now() + 5000;
		while (!handle) {
			try {
				handle = await open(lock, "wx", 0o600);
				await handle.writeFile(String(process.pid));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const pid = Number(await readFile(lock, "utf8").catch(() => "0"));
				if (pid > 0) {
					try {
						process.kill(pid, 0);
					} catch (e) {
						if ((e as NodeJS.ErrnoException).code === "ESRCH") {
							await rm(lock, { force: true });
							continue;
						}
					}
				}
				if (Date.now() > deadline) throw new Error("Another local configuration action is running");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		try {
			const state = await this.read();
			const previous = this.references;
			await work(state);
			const valid = stateSchema.parse(state);
			const refs: SecretReference[] = [];
			// Imported environments and HTTP credentials live in keychain entries. Even
			// the reference-bearing configuration (commands/args may contain secrets)
			// remains encrypted with a key held in the same persistent keychain.
			try {
				for (const server of valid.servers) {
					const field = server.transport === "stdio" ? "env" : "headers";
					const values = server.transport === "stdio" ? server.env : server.headers;
					for (const [key, value] of Object.entries(values)) {
						const name = "import:" + randomUUID();
						const entry = await this.entryFactory(name);
						entry.setPassword(value);
						refs.push({ id: server.id, field, key, name });
						values[key] = "";
					}
				}
			} catch (error) {
				for (const ref of refs)
					try {
						(await this.entryFactory(ref.name)).deletePassword();
					} catch {}
				throw error;
			}
			const key = await this.key(true),
				iv = randomBytes(12),
				cipher = createCipheriv("aes-256-gcm", key, iv);
			cipher.setAAD(Buffer.from("laplace-local/config/v1"));
			const ciphertext = Buffer.concat([
				cipher.update(JSON.stringify({ version: 2, state: valid, secrets: refs })),
				cipher.final(),
			]);
			const temporary = join(this.root, `config.${process.pid}.tmp`);
			await writeFile(
				temporary,
				Buffer.concat([Buffer.from("LMC1"), iv, cipher.getAuthTag(), ciphertext]),
				{ mode: 0o600 },
			);
			await rename(temporary, join(this.root, "config.enc"));
			this.references = refs;
			for (const ref of previous)
				try {
					(await this.entryFactory(ref.name)).deletePassword();
				} catch {
					/* A failed cleanup retains only an inaccessible orphan keychain entry. */
				}
		} finally {
			await handle.close();
			await rm(lock, { force: true });
		}
	}
	async doctor() {
		const entry = await this.entryFactory("doctor");
		const probe = randomBytes(32).toString("base64url");
		try {
			entry.setPassword(probe);
			if (entry.getPassword() !== probe) throw new Error();
			entry.deletePassword();
			await this.read();
			return { keychain: "available", configuration: "readable" };
		} catch {
			throw new Error(
				"Persistent keychain or encrypted configuration unavailable. Unlock your system keychain. Linux requires Secret Service.",
			);
		}
	}
}
