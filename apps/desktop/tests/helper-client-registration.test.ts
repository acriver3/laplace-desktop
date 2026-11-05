import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	configurePluginBridge,
	previewClientRegistration,
	registerClient,
	updateCodexConfiguration,
} from "@repo/local-runtime/client-registration";
import { helperInputs } from "@repo/local-runtime/shared/helper-contracts";
import { parse as parseToml } from "toml";
import { afterEach, expect, it, vi } from "vitest";

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
const base = {
	clientId: "11d9813a-6332-4c63-8eec-49421146cf32",
	nodePath: "/Applications/Laplace.app/Contents/Resources/runtimes/node",
	bridgePath: "/Applications/Laplace.app/Contents/Resources/helper/bridge.cjs",
	root: "/tmp/laplace-desktop-test",
};

it("copies a generic stdio entry without reading a client file or allowing automatic installation", async () => {
	const preview = await previewClientRegistration({
		...base,
		client: "other",
		get configPath(): string {
			throw new Error("A generic entry must not read client configuration");
		},
	});
	expect(preview.file).toBe("");
	expect(preview.entry).toEqual({
		command: base.nodePath,
		args: [base.bridgePath, "--root", base.root, "--client-id", base.clientId],
	});
	expect(
		helperInputs["client.install"].safeParse({ clientId: base.clientId, client: "other" }).success,
	).toBe(false);
});

it("backs up JSON configs, preserves unrelated entries and removes only explicitly chosen legacy entries", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-register-"));
	folders.push(root);
	const file = join(root, "client.json");
	const original = JSON.stringify({
		theme: "dark",
		mcpServers: {
			laplace: { url: "https://example.com/mcp" },
			"laplace-local": { command: "old-wrapper" },
			unrelated: { command: "node", env: { TOKEN: "synthetic-private-value" } },
		},
	});
	await writeFile(file, original);
	const input = { ...base, client: "claude-desktop" as const, configPath: file };
	const preview = await previewClientRegistration(input);
	expect(preview.legacyEntries).toEqual(["laplace", "laplace-local"]);
	expect(JSON.stringify(preview)).not.toContain("synthetic-private-value");
	const result = await registerClient({ ...input, removeLegacy: ["laplace-local"] });
	expect(result.backupFile && (await readFile(result.backupFile, "utf8"))).toBe(original);
	const updated = JSON.parse(await readFile(file, "utf8"));
	expect(updated.theme).toBe("dark");
	expect(updated.mcpServers.laplace).toEqual({ url: "https://example.com/mcp" });
	expect(updated.mcpServers["laplace-local"]).toBeUndefined();
	expect(updated.mcpServers.unrelated.env.TOKEN).toBe("synthetic-private-value");
	expect(updated.mcpServers["laplace-desktop"].args).toEqual([
		base.bridgePath,
		"--root",
		base.root,
		"--client-id",
		base.clientId,
	]);
	await expect(
		registerClient({ ...input, clientId: "b59d3029-f74d-4d17-9e0c-65d8f597b50d" }),
	).rejects.toThrow("explicitly");
});

it("preserves unrelated TOML exactly and removes selected nested server tables", () => {
	const original =
		'# keep this comment\nmodel = "example"\n\n[mcp_servers.laplace]\nurl = "https://example.com/mcp"\n\n[mcp_servers."laplace-local"]\ncommand="old"\n[mcp_servers."laplace-local".env]\nTOKEN="synthetic-private"\n\n[projects."/tmp/project"]\ntrust_level="trusted"\n';
	const updated = updateCodexConfiguration(
		original,
		{ command: base.nodePath, args: [base.bridgePath] },
		["laplace-local"],
	);
	expect(updated).toContain('# keep this comment\nmodel = "example"');
	expect(updated).toContain('[projects."/tmp/project"]\ntrust_level="trusted"');
	const parsed = parseToml(updated);
	expect(parsed.mcp_servers.laplace.url).toBe("https://example.com/mcp");
	expect(parsed.mcp_servers["laplace-local"]).toBeUndefined();
	expect(parsed.mcp_servers["laplace-desktop"].command).toBe(base.nodePath);
});

it("fails closed on unsupported inline TOML without rewriting the file", () => {
	expect(() =>
		updateCodexConfiguration('mcp_servers = { laplace-desktop = { command = "old" } }\n', {
			command: "new",
			args: [],
		}),
	).toThrow("unsupported");
});

it("writes a nonsecret plugin descriptor from the normal client registration", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-plugin-"));
	folders.push(root);
	const path = join(root, "plugin-bridge.json");
	vi.stubEnv("LAPLACE_PLUGIN_BRIDGE_CONFIG", path);
	try {
		await configurePluginBridge(base);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			command: base.nodePath,
			args: [base.bridgePath, "--root", base.root, "--client-id", base.clientId],
		});
	} finally {
		vi.unstubAllEnvs();
	}
});
