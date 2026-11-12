import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerConfig } from "@repo/local-mcp-core/config";
import {
	CatalogInstaller,
	catalogConfiguration,
	npmCatalogConfig,
} from "@repo/local-runtime/catalog";
import { bundleCatalog } from "@repo/local-runtime/library-catalog";
import { extractBundle, safeArchivePath } from "@repo/local-runtime/mcpb-archive";
import { npmPackageDirectory } from "@repo/local-runtime/npm-source";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const folders: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
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

const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
const source = (entry: (typeof bundleCatalog)[number]) => ({
	package: entry.npm!.package,
	version: entry.version,
	bin: entry.npm!.bin,
	integrity,
});

it("resolves Canvas npm settings without leaving placeholders or storing sessions inside the package", () => {
	const entry = bundleCatalog.find((candidate) => candidate.recipe === "canvas")!;
	const configuration = catalogConfiguration(
		entry,
		{ canvas_url: "https://canvas.example.edu" },
		"/tmp/desktop",
		"/tmp/desktop/npm-packages",
	);
	const result = npmCatalogConfig(
		entry,
		source(entry),
		{ command: "node", args: ["/pkg/bin/cli.js"] },
		configuration,
		"/pkg",
	);
	expect(result).toMatchObject({
		enabled: false,
		id: "canvas-session",
		command: "node",
		args: ["/pkg/bin/cli.js"],
		env: {
			CANVAS_URL: "https://canvas.example.edu",
			CANVAS_MCP_HOME: configuration.session_dir,
			CANVAS_MCP_BROWSER: "chrome",
		},
		identity: `npm:@withlaplace/canvas-session-mcp@${entry.version}`,
		npm: source(entry),
	});
	expect(result.cwd).toBeUndefined();
	expect(JSON.stringify(result)).not.toContain("${");
	expect(() =>
		catalogConfiguration(
			entry,
			{
				canvas_url: "https://canvas.example.edu",
				session_dir: "/tmp/desktop/npm-packages/profile",
			},
			"/tmp/desktop",
			"/tmp/desktop/npm-packages",
		),
	).toThrow("outside");
	expect(() =>
		catalogConfiguration(
			entry,
			{ canvas_url: "https://user:pass@canvas.example.edu" },
			"/tmp/desktop",
			"/tmp/desktop/npm-packages",
		),
	).toThrow("credentials");
	// Substituted values are never expanded again.
	expect(
		npmCatalogConfig(
			entry,
			source(entry),
			{ command: "node", args: ["/pkg/bin/cli.js"] },
			{ ...configuration, downloads_dir: "/tmp/${package_dir}" },
			"/pkg",
		).env.CANVAS_MCP_DOWNLOADS,
	).toBe("/tmp/${package_dir}");
	expect(() =>
		npmCatalogConfig(
			entry,
			{ ...source(entry), package: "@withlaplace/other" },
			{ command: "node", args: [] },
			configuration,
			"/pkg",
		),
	).toThrow("npm");
});

/** A verified npm installation, so catalog installs need only registry metadata. */
async function seedPackage(root: string, entry: (typeof bundleCatalog)[number], file: string) {
	const directory = npmPackageDirectory(root, source(entry));
	const packageDirectory = join(directory, "node_modules", ...entry.npm!.package.split("/"));
	await mkdir(join(packageDirectory, file, ".."), { recursive: true });
	await writeFile(
		join(packageDirectory, "package.json"),
		JSON.stringify({
			name: entry.npm!.package,
			version: entry.version,
			bin: { [entry.npm!.bin]: file },
		}),
	);
	await writeFile(join(packageDirectory, file), "process.exit(0);\n");
	await writeFile(
		join(directory, ".laplace-npm.json"),
		JSON.stringify({ package: entry.npm!.package, version: entry.version, integrity }),
	);
	return packageDirectory;
}
function registry(entry: (typeof bundleCatalog)[number], file: string) {
	return vi.fn(async (url: string | URL | Request) => {
		expect(String(url)).toContain(entry.npm!.package.replace("/", "%2F"));
		return Response.json({
			name: entry.npm!.package,
			"dist-tags": { latest: entry.version },
			versions: {
				[entry.version]: { bin: { [entry.npm!.bin]: file }, dist: { integrity } },
			},
		});
	}) as unknown as typeof fetch;
}

it.each([
	["canvas", false],
	["slack-ready", false],
	["canvas", true],
	["slack-ready", true],
] as const)("verifies %s with recovery flag %s", async (recipe, recovery) => {
	vi.stubEnv("LAPLACE_SESSION_RECOVERY_V1", String(recovery));
	// The in-memory install fixture exercises a reviewed desktop platform,
	// including when source checks run on the Linux Workers Builds image.
	vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
	const root = await mkdtemp(join(tmpdir(), "laplace-catalog-flow-"));
	folders.push(root);
	const entry = bundleCatalog.find((candidate) => candidate.recipe === recipe)!;
	const id = recipe === "canvas" ? "canvas-session" : "slack";
	const file = recipe === "canvas" ? "bin/cli.js" : "browser/cli.mjs";
	const packageDirectory = await seedPackage(root, entry, file);
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
		fetch: registry(entry, file),
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
	expect(configs.get(id)).toMatchObject({
		enabled: false,
		command: "node",
		args:
			recipe === "canvas"
				? [join(packageDirectory, file)]
				: [
						join(packageDirectory, file),
						"serve",
						"--workspace",
						"https://fixture.slack.com",
						"--profile-dir",
						join(root, "sessions", "slack", "profile"),
					],
		identity: `npm:${entry.npm!.package}@${entry.version}`,
	});
	expect(JSON.parse(await readFile(join(root, "catalog-installs.json"), "utf8"))).toEqual([
		expect.objectContaining({
			serverId: id,
			package: entry.npm!.package,
			version: entry.version,
		}),
	]);
	const verify = await installer.verify(id);
	if (recovery) expect((await installer.verify(id)).id).toBe(verify.id);
	await vi.waitFor(() =>
		expect(installer.jobs().find((job) => job.id === verify.id)?.status).toBe("completed"),
	);
	expect(calls).toEqual(
		recipe === "canvas" ? ["canvas_whoami", "canvas_list_courses"] : ["channels_list"],
	);
	expect(configs.get(id)?.enabled).toBe(!recovery);
	if (recovery) await manager.setEnabled(id, true);
	failRead = true;
	const failed = await installer.verify(id);
	await vi.waitFor(() =>
		expect(installer.jobs().find((job) => job.id === failed.id)?.status).toBe("failed"),
	);
	expect(configs.get(id)?.enabled).toBe(recovery);
	if (recovery)
		expect(installer.jobs().find((job) => job.id === failed.id)?.recovery?.state).toBe(
			"sign_in_required",
		);
	expect((await installer.list()).find((item) => item.id === entry.id)?.installed).toBe(true);
	configs.delete(id);
	expect((await installer.list()).find((item) => item.id === entry.id)?.installed).toBe(false);
});

it("defaults background session checks off and passes explicit opt-in to both connectors", () => {
	for (const recipe of ["canvas", "yale-som-ems"]) {
		const entry = bundleCatalog.find((candidate) => candidate.recipe === recipe)!;
		const configure = (setting?: string) => catalogConfiguration(entry, {
			...(recipe === "canvas" ? { canvas_url: "https://canvas.example.edu" } : {}),
			...(setting ? { background_session_checks: setting } : {}),
		}, "/tmp/state", "/tmp/packages");
		const launch = (settings: Record<string, string>) => npmCatalogConfig(
			entry, source(entry), { command: "node", args: ["/pkg/cli.js"] }, settings, "/pkg",
		);
		expect(launch(configure()).env.LAPLACE_BACKGROUND_SESSION_CHECKS).toBe("off");
		expect(launch(configure("on")).env.LAPLACE_BACKGROUND_SESSION_CHECKS).toBe("on");
		expect(() => configure("always")).toThrow("Choose on or off");
	}
});

it("launches the Slack npm package with read-only tools", () => {
	const entry = bundleCatalog.find((item) => item.recipe === "slack-ready")!;
	expect(entry.candidate).toBe(true);
	const config = npmCatalogConfig(
		entry,
		source(entry),
		{ command: "node", args: ["/pkg/browser/cli.mjs"] },
		{ workspace: "https://fixture.slack.com", profile_dir: "/sessions/slack" },
		"/pkg",
	);
	expect(config).toMatchObject({
		id: "slack",
		command: "node",
		args: [
			"/pkg/browser/cli.mjs",
			"serve",
			"--workspace",
			"https://fixture.slack.com",
			"--profile-dir",
			"/sessions/slack",
		],
		env: {
			SLACK_MCP_ENABLED_TOOLS:
				"channels_list,conversations_history,conversations_replies,conversations_search_messages",
		},
	});
});

it("rejects non-workspace Slack URLs and profiles inside installed packages", () => {
	const entry = bundleCatalog.find((item) => item.recipe === "slack-ready")!;
	for (const workspace of [
		"https://example.com",
		"https://app.slack.com",
		"https://team.slack.com:444",
		"http://team.slack.com",
		"https://user:pass@team.slack.com",
	])
		expect(() => catalogConfiguration(entry, { workspace }, "/state", "/packages")).toThrow();
	expect(() =>
		catalogConfiguration(
			entry,
			{ workspace: "https://team.slack.com", profile_dir: "/packages/profile" },
			"/state",
			"/packages",
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
