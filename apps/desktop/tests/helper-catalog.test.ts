import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerConfig } from "@repo/local-mcp-core/config";
import { afterAll, afterEach, expect, it, vi } from "vitest";

import {
	CatalogInstaller,
	extractBundle,
	safeArchivePath,
	downloadBundle,
	catalogConfiguration,
	resolveManifestConfiguration,
} from "../src/helper/catalog";
import { bundleCatalog } from "../src/helper/library-catalog";

const folders: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
function zip(files: Array<{ name: string; data: string; mode?: number }>) {
	const local: Buffer[] = [],
		central: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name),
			data = Buffer.from(file.data);
		let crc = 0xffffffff;
		for (const byte of data) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		crc = (crc ^ 0xffffffff) >>> 0;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(name.length, 26);
		local.push(header, name, data);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50);
		directory.writeUInt16LE(0x314, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt32LE(crc, 16);
		directory.writeUInt32LE(data.length, 20);
		directory.writeUInt32LE(data.length, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, name);
		offset += header.length + name.length + data.length;
	}
	const directory = Buffer.concat(central),
		end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

it("extracts regular files and rejects traversal, links and case-colliding entries", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-bundle-"));
	folders.push(root);
	await extractBundle(zip([{ name: "dist/server.js", data: "safe" }]), join(root, "valid"));
	expect(await readFile(join(root, "valid/dist/server.js"), "utf8")).toBe("safe");
	await expect(
		extractBundle(zip([{ name: "../escape", data: "unsafe" }]), join(root, "traversal")),
	).rejects.toThrow();
	await expect(
		extractBundle(zip([{ name: "link", data: "/outside", mode: 0o120777 }]), join(root, "link")),
	).rejects.toThrow("linked");
	await expect(
		extractBundle(
			zip([
				{ name: "FILE", data: "a" },
				{ name: "file", data: "b" },
			]),
			join(root, "duplicate"),
		),
	).rejects.toThrow("duplicate");
	for (const name of [
		"/absolute",
		"C:/drive",
		"a\\b",
		"a/../b",
		"a//b",
		"dir/CON",
		"dir/nul.txt",
		"COM1/file",
		"control\u0001.txt",
	])
		expect(() => safeArchivePath(name)).toThrow();
});

it("verifies downloaded bytes before returning them and stops mismatched or cancelled downloads", async () => {
	const bytes = Buffer.from("reviewed bytes"),
		artifact = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
	const controller = new AbortController();
	const fetcher = (async () => new Response(bytes)) as typeof fetch;
	expect(
		await downloadBundle("https://example.com/bundle", artifact, controller.signal, fetcher),
	).toEqual(bytes);
	await expect(
		downloadBundle(
			"https://example.com/bundle",
			{ ...artifact, sha256: "0".repeat(64) },
			controller.signal,
			fetcher,
		),
	).rejects.toThrow("checksum");
	await expect(
		downloadBundle(
			"https://example.com/bundle",
			{ ...artifact, size: 1 },
			controller.signal,
			fetcher,
		),
	).rejects.toThrow("exceeds");
	controller.abort();
	await expect(
		downloadBundle("https://example.com/bundle", artifact, controller.signal, fetcher),
	).rejects.toThrow("cancelled");
});

it("resolves pinned Canvas manifest settings without leaving placeholders or storing sessions inside source", () => {
	const entry = bundleCatalog.find((candidate) => candidate.recipe === "canvas")!;
	const configuration = catalogConfiguration(
		entry,
		{ canvas_url: "https://canvas.example.edu" },
		"/tmp/desktop",
		"/tmp/bundle",
	);
	const manifest = {
		name: entry.id,
		version: entry.version,
		server: {
			mcp_config: {
				command: "node",
				args: ["${__dirname}/bin/cli.js"],
				env: {
					CANVAS_URL: "${user_config.canvas_url}",
					CANVAS_MCP_HOME: "${user_config.session_dir}",
				},
			},
		},
	};
	const result = resolveManifestConfiguration(manifest, entry, "/tmp/bundle", configuration);
	expect(result.enabled).toBe(false);
	expect(result.id).toBe("canvas-session");
	expect(JSON.stringify(result)).not.toContain("${");
	expect(() =>
		catalogConfiguration(
			entry,
			{ canvas_url: "https://canvas.example.edu", session_dir: "/tmp/bundle/profile" },
			"/tmp/desktop",
			"/tmp/bundle",
		),
	).toThrow("outside");
	expect(() =>
		catalogConfiguration(
			entry,
			{ canvas_url: "https://user:pass@canvas.example.edu" },
			"/tmp/desktop",
			"/tmp/bundle",
		),
	).toThrow("credentials");
	expect(() =>
		resolveManifestConfiguration(
			{ ...manifest, version: "different" },
			entry,
			"/tmp/bundle",
			configuration,
		),
	).toThrow("identity");
});

it.each(["canvas", "slack-ready"])(
	"installs %s disabled, verifies reads, and disables a failed connection",
	async (recipe) => {
		// The in-memory install fixture exercises a reviewed desktop platform,
		// including when source checks run on the Linux Workers Builds image.
		vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
		const root = await mkdtemp(join(tmpdir(), "laplace-catalog-flow-"));
		folders.push(root);
		const entry = bundleCatalog.find((candidate) => candidate.recipe === recipe)!;
		const id = recipe === "canvas" ? "canvas-session" : "slack";
		const directory = join(root, "connectors", entry.id, entry.version);
		await mkdir(join(directory, "bin"), { recursive: true });
		await writeFile(
			join(directory, ".laplace-bundle.json"),
			JSON.stringify({
				sha256: entry.artifacts.find((item) => item.platforms.includes("darwin-arm64"))!.sha256,
			}),
		);
		await writeFile(
			join(directory, "manifest.json"),
			JSON.stringify({
				name: entry.id,
				version: entry.version,
				server: {
					mcp_config: {
						command: "node",
						args: ["${__dirname}/bin/cli.js"],
						env: { CANVAS_URL: "${user_config.canvas_url}" },
					},
				},
			}),
		);
		const configs = new Map<string, ServerConfig>(),
			calls: string[] = [];
		let failRead = false;
		const manager = {
			async addServers(servers: ServerConfig[]) {
				for (const server of servers) configs.set(server.id, server);
			},
			getServerConfig(id: string) {
				const config = configs.get(id);
				if (!config) throw new Error("Not found");
				return config;
			},
			async setEnabled(id: string, enabled: boolean) {
				configs.get(id)!.enabled = enabled;
			},
			async restartServer() {},
			async catalogSetupCall(_id: string, name: string) {
				calls.push(name);
				return failRead
					? { content: [{ type: "text", text: JSON.stringify({ authenticated: false }) }] }
					: { isError: false };
			},
		};
		const installer = new CatalogInstaller(manager, {
			root,
			resources: join(root, "resources"),
			nodePath: process.execPath,
			fetch: vi.fn(async () => {
				throw new Error("Unexpected download");
			}),
		});
		const install = await installer.install({
			catalogId: entry.id,
			configuration:
				recipe === "canvas"
					? { canvas_url: "https://canvas.example.edu" }
					: { workspace: "https://fixture.slack.com" },
		});
		await vi.waitFor(() =>
			expect(installer.jobs().find((job) => job.id === install.id)?.status).toBe("completed"),
		);
		expect(configs.get(id)?.enabled).toBe(false);
		const verify = await installer.verify(id);
		await vi.waitFor(() =>
			expect(installer.jobs().find((job) => job.id === verify.id)?.status).toBe("completed"),
		);
		expect(calls).toEqual(
			recipe === "canvas" ? ["canvas_whoami", "canvas_list_courses"] : ["channels_list"],
		);
		expect(configs.get(id)?.enabled).toBe(true);
		failRead = true;
		const failed = await installer.verify(id);
		await vi.waitFor(() =>
			expect(installer.jobs().find((job) => job.id === failed.id)?.status).toBe("failed"),
		);
		expect(configs.get(id)?.enabled).toBe(false);
		expect((await installer.list()).find((item) => item.id === entry.id)?.installed).toBe(true);
		configs.delete(id);
		expect((await installer.list()).find((item) => item.id === entry.id)?.installed).toBe(false);
	},
);

it.each(["win32", "darwin", "linux"])(
	"uses the pinned Slack runtime and read-only tools on %s",
	(platform) => {
		vi.stubGlobal("process", { ...process, platform });
		const entry = bundleCatalog.find((item) => item.recipe === "slack-ready")!;
		const config = resolveManifestConfiguration(
			{
				name: entry.id,
				version: entry.version,
				server: { mcp_config: { command: "untrusted", args: [] } },
			},
			entry,
			"/bundle",
			{ workspace: "https://fixture.slack.com", profile_dir: "/sessions/slack" },
		);
		expect(config.transport).toBe("stdio");
		if (config.transport !== "stdio") throw new Error("Expected stdio");
		expect(config.command).toBe(
			join("/bundle", "runtime", platform === "win32" ? "node.exe" : "node"),
		);
		expect(config.args).toContain("/sessions/slack");
		expect(config.env).toEqual({
			SLACK_MCP_ENABLED_TOOLS:
				"channels_list,conversations_history,conversations_replies,conversations_search_messages",
		});
	},
);

it("rejects non-workspace Slack URLs and profiles inside the bundle", () => {
	const entry = bundleCatalog.find((item) => item.recipe === "slack-ready")!;
	for (const workspace of [
		"https://example.com",
		"https://app.slack.com",
		"https://team.slack.com:444",
		"http://team.slack.com",
		"https://user:pass@team.slack.com",
	])
		expect(() => catalogConfiguration(entry, { workspace }, "/state", "/bundle")).toThrow();
	expect(() =>
		catalogConfiguration(
			entry,
			{ workspace: "https://team.slack.com", profile_dir: "/bundle/profile" },
			"/state",
			"/bundle",
		),
	).toThrow("outside");
});

// Historical bundle/limited-Slack coverage remains explicit after Mac release activation.
const previousTetheredFlag = vi.hoisted(() => {
	const previous = process.env.LAPLACE_TETHERED_BROWSER_V1;
	process.env.LAPLACE_TETHERED_BROWSER_V1 = "false";
	return previous;
});
afterAll(() => {
	if (previousTetheredFlag === undefined) delete process.env.LAPLACE_TETHERED_BROWSER_V1;
	else process.env.LAPLACE_TETHERED_BROWSER_V1 = previousTetheredFlag;
});
