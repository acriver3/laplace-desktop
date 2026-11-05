import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, it, expect } from "vitest";

import { serverConfig } from "../src/config";
import { LocalStore, type EntryFactory } from "../src/store";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "laplace-store-"));
	roots.push(root);
	const values = new Map<string, string>();
	const entries: EntryFactory = async (name) => ({
		getPassword: () => values.get(name) ?? null,
		setPassword: (value) => {
			values.set(name, value);
		},
		deletePassword: () => {
			values.delete(name);
		},
	});
	return { root, values, store: new LocalStore(root, entries) };
}
it("encrypts imported secrets and stores installation credentials only in keychain", async () => {
	const { root, store, values } = await fixture();
	await store.credential("synthetic-installation-token");
	await store.mutate((s) => {
		s.servers.push(
			serverConfig.parse({
				id: "custom",
				name: "custom",
				transport: "stdio",
				command: "node",
				env: { TOKEN: "synthetic-local-secret" },
			}),
		);
	});
	const bytes = await readFile(join(root, "config.enc"));
	expect(bytes.toString()).not.toMatch(/synthetic|TOKEN|command/);
	expect((await store.read()).servers[0]).toMatchObject({
		env: { TOKEN: "synthetic-local-secret" },
	});
	expect([...values.values()]).toContain("synthetic-local-secret");
	expect(values.get("installation")).toBe("synthetic-installation-token");
	bytes[bytes.length - 1] ^= 1;
	await writeFile(join(root, "config.enc"), bytes);
	await expect(store.read()).rejects.toThrow("Cannot decrypt");
});
it("fails closed when keychain is unavailable or its encryption key disappears", async () => {
	const { store, root, values } = await fixture();
	await store.mutate(() => {});
	values.clear();
	await expect(store.read()).rejects.toThrow();
	const unavailable = new LocalStore(root, async () => {
		throw new Error("Keychain unavailable");
	});
	await expect(unavailable.mutate(() => {})).rejects.toThrow();
	await expect(unavailable.doctor()).rejects.toThrow();
	expect((await readFile(join(root, "config.enc"))).subarray(0, 4).toString()).toBe("LMC1");
});
it("serializes config mutations from concurrent clients", async () => {
	const { store } = await fixture();
	await Promise.all(
		["one", "two"].map((id) =>
			store.mutate((s) => {
				s.servers.push(serverConfig.parse({ id, name: id, transport: "stdio", command: "node" }));
			}),
		),
	);
	expect((await store.read()).servers.map((s) => s.id).sort()).toEqual(["one", "two"]);
});
