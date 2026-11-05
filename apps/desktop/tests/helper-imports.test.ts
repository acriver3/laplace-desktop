import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalStore, type EntryFactory } from "@repo/local-mcp-core/store";
import { afterEach, describe, expect, it } from "vitest";

import {
	previewConfiguration,
	previewImportFile,
	importSelectedFile,
	normalizeManualConfiguration,
} from "@repo/local-runtime/imports";
import { previewLegacyMigration, migrateSelectedLegacy } from "@repo/local-runtime/migration";

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
async function temporary() {
	const root = await mkdtemp(join(tmpdir(), "laplace-desktop-import-"));
	folders.push(root);
	return root;
}

describe("selected local configuration imports", () => {
	it("previews only credential names and imports only selected JSON entries without modifying the source", async () => {
		const root = await temporary(),
			file = join(root, "mcp.json");
		const content = JSON.stringify({
			preferences: { unchanged: true },
			mcpServers: {
				chosen: {
					command: "node",
					args: ["server.mjs", "--token", "synthetic-private-argument"],
					env: { TOKEN: "synthetic-private-value" },
				},
				unrelated: { command: "other" },
			},
		});
		await writeFile(file, content);
		const preview = await previewImportFile(file);
		expect(JSON.stringify(preview)).not.toContain("synthetic-private");
		expect(preview.entries[0]?.secretKeys).toEqual(["TOKEN"]);
		expect(preview.entries[0]?.args).toEqual(["server.mjs", "--token", "••••"]);
		const imported = await importSelectedFile(file, ["chosen"], preview.fingerprint);
		expect(imported).toHaveLength(1);
		expect(imported[0]?.transport === "stdio" && imported[0].env.TOKEN).toBe(
			"synthetic-private-value",
		);
		expect(await readFile(file, "utf8")).toBe(content);
		await writeFile(file, content + " ");
		await expect(importSelectedFile(file, ["chosen"], preview.fingerprint)).rejects.toThrow(
			"changed",
		);
	});
	it("resolves Codex environment references locally and preserves disabled state", () => {
		const preview = previewConfiguration(
			'[mcp_servers.local]\ncommand="node"\nargs=["server.mjs"]\nenabled=false\nenv_vars=["TEST_TOKEN"]\n',
			"toml",
			"/tmp/config.toml",
			{ TEST_TOKEN: "synthetic-private-token" },
		);
		expect(preview.entries[0]).toMatchObject({
			id: "local",
			enabled: false,
			secretKeys: ["TEST_TOKEN"],
		});
		expect(JSON.stringify(preview)).not.toContain("synthetic-private-token");
	});
	it("rejects remote HTTP, recursion, unsupported restrictions and missing env values while leaving other entries selectable", () => {
		const preview = previewConfiguration(
			JSON.stringify({
				mcpServers: {
					remote: { url: "https://example.com/mcp" },
					"laplace-desktop": { command: "node" },
					local: { command: "node" },
				},
			}),
			"json",
			"/tmp/config.json",
		);
		expect(preview.entries[0]?.error).toBeTruthy();
		expect(preview.entries[1]?.error).toContain("itself");
		expect(preview.entries[2]?.error).toBeUndefined();
		expect(
			previewConfiguration(
				'[mcp_servers.a]\ncommand="node"\ndisabled_tools=["write"]\n',
				"toml",
				"/tmp/config.toml",
			).entries[0]?.error,
		).toContain("unsupported");
		expect(
			previewConfiguration(
				'[mcp_servers.a]\ncommand="node"\nenv_vars=["MISSING"]\n',
				"toml",
				"/tmp/config.toml",
				{},
			).entries[0]?.error,
		).toContain("unavailable");
	});
	it("requires literal loopback HTTP and absolute manual working directories", () => {
		expect(() =>
			normalizeManualConfiguration({
				id: "a",
				name: "A",
				transport: "http",
				url: "http://localhost:123/mcp",
			}),
		).toThrow();
		expect(() =>
			normalizeManualConfiguration({
				id: "a",
				name: "A",
				transport: "stdio",
				command: "node",
				cwd: "relative",
			}),
		).toThrow("absolute");
		expect(
			normalizeManualConfiguration({
				id: "a",
				name: "A",
				transport: "http",
				url: "http://127.0.0.1:123/mcp",
			}).id,
		).toBe("a");
	});
});

it("migrates selected legacy connections disabled without transferring pairing or modifying the encrypted source", async () => {
	const root = await temporary();
	const secrets = new Map<string, string>();
	const entries: EntryFactory = async (key) => ({
		getPassword: () => secrets.get(key) ?? null,
		setPassword: (value) => {
			secrets.set(key, value);
		},
		deletePassword: () => {
			secrets.delete(key);
		},
	});
	const store = new LocalStore(root, entries);
	await store.mutate((state) => {
		state.servers = [
			normalizeManualConfiguration({
				id: "chosen",
				name: "Chosen",
				transport: "stdio",
				command: "node",
				env: { TOKEN: "synthetic-credential" },
			}),
			normalizeManualConfiguration({
				id: "other",
				name: "Other",
				transport: "stdio",
				command: "node",
			}),
		];
	});
	const before = await readFile(join(root, "config.enc"));
	const preview = await previewLegacyMigration(root, entries);
	const copied = await migrateSelectedLegacy(root, ["chosen"], entries);
	expect(JSON.stringify(preview)).not.toContain("synthetic-credential");
	expect(copied).toHaveLength(1);
	expect(copied[0]?.enabled).toBe(false);
	expect(await readFile(join(root, "config.enc"))).toEqual(before);
});
