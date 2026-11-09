import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ConnectorUpdates } from "@repo/local-mcp-core/connector-updates";
import type { EntryFactory } from "@repo/local-mcp-core/store";
import { UpdatePolicyStore } from "@repo/local-mcp-core/update-policy";
import { CatalogInstaller } from "@repo/local-runtime/catalog";
import { bundleCatalog } from "@repo/local-runtime/library-catalog";
import { DesktopManager } from "@repo/local-runtime/manager";
import { npmInstalledPackage } from "@repo/local-runtime/npm-source";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) await task();
});

// Packaging downloads the bundled npm; before that, use the npm that ships with this Node.
function testResources() {
	const bundled = resolve("resources");
	if (existsSync(join(bundled, "runtimes", "npm", "bin", "npm-cli.js"))) return bundled;
	const npm = [
		join(dirname(process.execPath), "..", "lib", "node_modules", "npm"),
		join(dirname(process.execPath), "node_modules", "npm"),
		join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim(), "npm"),
	].find((candidate) => existsSync(join(candidate, "bin", "npm-cli.js")))!;
	const fallback = mkdtempSync(join(tmpdir(), "npm-resources-"));
	mkdirSync(join(fallback, "runtimes"));
	symlinkSync(npm, join(fallback, "runtimes", "npm"), "junction");
	return fallback;
}
const resources = testResources();
const npmCli = join(resources, "runtimes", "npm", "bin", "npm-cli.js");
const ems = bundleCatalog.find((entry) => entry.recipe === "yale-som-ems")!;
const name = ems.npm!.package;

/** Dependency-free stdio MCP server that records its launch and exposes the given tools. */
function connectorSource(tools: string[]) {
	return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.env.LAUNCH_LOG)
	appendFileSync(process.env.LAUNCH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const tools = ${JSON.stringify(tools)};
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	const result =
		request.method === "initialize"
			? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ems-fixture", version: "0" } }
			: request.method === "tools/list"
				? { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) }
				: { content: [{ type: "text", text: "{}" }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`;
}

let server: Server;
let registryUrl: string;
let packument: {
	name: string;
	"dist-tags": Record<string, string>;
	versions: Record<string, unknown>;
};
const work = mkdtempSync(join(tmpdir(), "npm-catalog-registry-"));
afterAll(async () => {
	server?.close();
	await rm(work, { recursive: true, force: true });
});

/** A loopback registry serving the catalog's scoped EMS package, with npm-shrinkwrap.json. */
beforeAll(async () => {
	const tarballs = new Map<string, Buffer>();
	packument = { name, "dist-tags": { latest: ems.version }, versions: {} };
	server = createServer((request, response) => {
		const path = decodeURIComponent(request.url!);
		const tarball = tarballs.get(path);
		if (tarball) return response.end(tarball);
		if (path.toLowerCase() === `/${name}`) {
			response.setHeader("content-type", "application/json");
			return response.end(JSON.stringify(packument));
		}
		response.statusCode = 404;
		response.end("{}");
	});
	await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
	registryUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const versions: Record<string, string[]> = {
		[ems.version]: ["ems_session_status", "ems_list_templates"],
		"0.1.2": ["ems_session_status", "ems_list_templates", "ems_new_tool"],
	};
	for (const [version, tools] of Object.entries(versions)) {
		const directory = join(work, version);
		await mkdir(join(directory, "dist"), { recursive: true });
		const manifest = {
			name,
			version,
			type: "module",
			bin: { [ems.npm!.bin]: "dist/cli.js" },
		};
		await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
		await writeFile(
			join(directory, "npm-shrinkwrap.json"),
			JSON.stringify({
				name,
				version,
				lockfileVersion: 3,
				requires: true,
				packages: { "": { name, version, bin: manifest.bin } },
			}),
		);
		await writeFile(join(directory, "dist", "cli.js"), connectorSource(tools));
		execFileSync(process.execPath, [npmCli, "pack", "--silent"], { cwd: directory });
		const file = (await readdir(directory)).find((entry) => entry.endsWith(".tgz"))!;
		const bytes = await readFile(join(directory, file));
		const path = `/${name}/-/yale-som-ems-mcp-${version}.tgz`;
		tarballs.set(path, bytes);
		packument.versions[version] = {
			name,
			version,
			bin: manifest.bin,
			dist: {
				tarball: registryUrl + path,
				integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
			},
		};
	}
}, 120_000);

async function desktop() {
	// EMS is accepted on Windows x64 and Apple Silicon; offer it on this test platform too.
	const { candidate, platforms } = ems;
	ems.candidate = true;
	ems.platforms = [...platforms, `${process.platform}-${process.arch}` as never];
	cleanup.push(() => {
		ems.candidate = candidate;
		ems.platforms = platforms;
	});
	const root = await mkdtemp(join(tmpdir(), "npm-catalog-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const secrets = new Map<string, string>();
	const entries: EntryFactory = async (key) => ({
		getPassword: () => secrets.get(key) ?? null,
		setPassword: (value) => void secrets.set(key, value),
		deletePassword: () => void secrets.delete(key),
	});
	const manager = new DesktopManager(root, resources, "https://connect.fixture.invalid", {
		entries,
	});
	cleanup.push(() => manager.shutdown());
	await manager.initialize();
	const catalog = () =>
		new CatalogInstaller(manager, {
			root,
			resources,
			nodePath: process.execPath,
			registry: registryUrl,
		});
	const policy = new UpdatePolicyStore(join(root, "policy"));
	const updates = (installer: CatalogInstaller) =>
		new ConnectorUpdates(
			{
				root,
				version: "0.1.43",
				kind: "desktop",
				entries,
				configurations: async () => (await manager.store.read()).servers,
				replace: (config, expected) => manager.replaceManagedUpdate(config, expected),
				verify: async () => {},
				maintenance: async () => () => {},
				busy: () => false,
				idleSeconds: async () => 3600,
				npm: {
					targets: () => installer.npmUpdateTargets(),
					latest: (id, signal) => installer.latestNpmVersion(id, signal),
					stage: (id, version, signal) => installer.stageNpmVersion(id, version, signal),
					apply: (id, version, signal) => installer.applyNpmVersion(id, version, signal),
				},
			},
			policy,
			undefined,
			// The signed feed is unreachable; npm checks still complete.
			(async () => {
				throw new Error("offline");
			}) as unknown as typeof fetch,
		);
	return { root, manager, catalog, updates, policy };
}

it("installs Yale SOM EMS from npm with resolved catalog arguments and an npm identity", async () => {
	const { root, manager, catalog } = await desktop();
	const installer = catalog();
	const profile = join(root, "profiles", "ems");
	const job = await installer.install({
		catalogId: ems.id,
		configuration: { profile_dir: profile, browser: "msedge" },
	});
	await vi.waitFor(
		() => expect(installer.jobs().find((item) => item.id === job.id)?.status).toBe("completed"),
		{ timeout: 120_000 },
	);
	const source = {
		package: name,
		version: ems.version,
		bin: "yale-som-ems-mcp",
		integrity: (packument.versions[ems.version] as { dist: { integrity: string } }).dist.integrity,
	};
	const packageDirectory = npmInstalledPackage(root, source);
	const config = manager.getServerConfig("yale-som-ems");
	expect(config).toEqual(
		expect.objectContaining({
			id: "yale-som-ems",
			enabled: false,
			transport: "stdio",
			command: "node",
			args: [
				join(packageDirectory, "dist", "cli.js"),
				"serve",
				"--profile-dir",
				profile,
				"--browser",
				"msedge",
			],
			env: {},
			npm: source,
			identity: `npm:${name}@${ems.version}`,
		}),
	);
	expect(JSON.stringify(config)).not.toContain("${");
	expect(await installer.list()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: ems.id,
				installed: true,
				installedVersion: ems.version,
				npm: { package: name, distTag: "latest" },
			}),
		]),
	);
	expect(await installer.npmUpdateTargets()).toEqual([
		{ id: "yale-som-ems", name: config.name, version: ems.version, legacy: false },
	]);
	expect(await installer.portableSnapshot("yale-som-ems")).toMatchObject({
		bundle: { kind: "catalog", catalogId: ems.id, version: ems.version, package: name },
	});
	// A new Desktop session resolves the installation from its npm receipt.
	expect((await catalog().list()).find((item) => item.id === ems.id)?.installed).toBe(true);
}, 180_000);

it("migrates a legacy bundle installation to npm, keeping its settings, ID and tool approvals", async () => {
	const { root, manager, catalog, updates, policy } = await desktop();
	const directory = join(root, "connectors", ems.id, "0.1.0");
	await mkdir(join(directory, "dist"), { recursive: true });
	await writeFile(join(directory, "dist", "cli.js"), connectorSource(["ems_session_status"]));
	const profile = join(root, "sessions", "custom-ems-profile");
	const launchLog = join(root, "launch.log");
	await manager.addServers(
		[
			{
				id: "yale-som-ems",
				name: "My EMS",
				transport: "stdio",
				enabled: true,
				generation: crypto.randomUUID(),
				catalog: "custom",
				command: "node",
				args: [join(directory, "dist", "cli.js"), "serve", "--profile-dir", profile],
				env: { LAUNCH_LOG: launchLog },
				cwd: directory,
				identity: `${ems.id}@0.1.0`,
			},
		],
		false,
		{ localOnly: true },
	);
	await vi.waitFor(() =>
		expect(manager.listServers().find((s) => s.id === "yale-som-ems")?.status).toBe("online"),
	);
	await writeFile(
		join(root, "catalog-installs.json"),
		JSON.stringify([
			{
				catalogId: ems.id,
				version: "0.1.0",
				serverId: "yale-som-ems",
				directory,
				configuration: { profile_dir: profile, browser: "msedge" },
			},
		]),
	);
	const installer = catalog();
	expect(await installer.npmUpdateTargets()).toEqual([
		{ id: "yale-som-ems", name: "My EMS", version: "0.1.0", legacy: true },
	]);
	const connectorUpdates = updates(installer);
	// Migration follows the automatic-update policy; with it off, the bundle stays.
	expect(await connectorUpdates.migrate()).toEqual([]);
	expect(manager.getServerConfig("yale-som-ems").identity).toBe(`${ems.id}@0.1.0`);
	await policy.mutate((value) => {
		value.connectors = true;
	});
	// A pinned connector stays on its bundle.
	await connectorUpdates.pin("yale-som-ems", true);
	expect(await connectorUpdates.migrate()).toEqual([]);
	expect(manager.getServerConfig("yale-som-ems").identity).toBe(`${ems.id}@0.1.0`);
	await connectorUpdates.pin("yale-som-ems", false);

	expect(await connectorUpdates.migrate()).toEqual([{ id: "yale-som-ems" }]);
	const migrated = manager.getServerConfig("yale-som-ems");
	expect(migrated).toMatchObject({
		id: "yale-som-ems",
		name: "My EMS",
		enabled: true,
		identity: `npm:${name}@${ems.version}`,
		npm: { package: name, version: ems.version },
		// The migrated environment comes from the catalog, not the old bundle manifest.
		env: {},
	});
	expect(migrated.transport === "stdio" && migrated.cwd).toBeFalsy();
	expect(migrated.transport === "stdio" && migrated.args.slice(1)).toEqual([
		"serve",
		"--profile-dir",
		profile,
		"--browser",
		"msedge",
	]);
	// Tools introduced by the npm version wait for approval.
	expect(migrated.enabledTools).toEqual(["ems_session_status"]);
	const tools = manager.listServers().find((s) => s.id === "yale-som-ems")!.tools;
	expect(tools.find((tool) => tool.name === "ems_list_templates")?.localEnabled).toBe(false);
	expect(JSON.parse(await readFile(join(root, "catalog-installs.json"), "utf8"))).toEqual([
		expect.objectContaining({
			serverId: "yale-som-ems",
			package: name,
			version: ems.version,
			configuration: { profile_dir: profile, browser: "msedge" },
		}),
	]);
	expect(await installer.npmUpdateTargets()).toEqual([
		{ id: "yale-som-ems", name: "My EMS", version: ems.version, legacy: false },
	]);
	expect(await connectorUpdates.migrate()).toEqual([]);

	// Updates follow the dist-tag through the npm path and respect the automatic-update policy.
	packument["dist-tags"].latest = "0.1.2";
	cleanup.push(() => {
		packument["dist-tags"].latest = ems.version;
	});
	await expect(connectorUpdates.check()).rejects.toThrow();
	expect(await connectorUpdates.status()).toEqual([
		expect.objectContaining({
			id: "yale-som-ems",
			version: ems.version,
			availableVersion: "0.1.2",
			pinned: false,
		}),
	]);
	vi.stubEnv("LAPLACE_AUTOMATIC_UPDATES_V1", "true");
	cleanup.push(() => vi.unstubAllEnvs());
	await policy.mutate((value) => {
		value.connectors = false;
	});
	await connectorUpdates.apply("yale-som-ems", true);
	expect(manager.getServerConfig("yale-som-ems")).toMatchObject({
		npm: { version: ems.version },
	});
	await policy.mutate((value) => {
		value.connectors = true;
	});
	await connectorUpdates.apply("yale-som-ems", true);
	expect(manager.getServerConfig("yale-som-ems")).toMatchObject({
		identity: `npm:${name}@0.1.2`,
		enabledTools: ["ems_session_status"],
	});
	expect((await connectorUpdates.status())[0]).toMatchObject({
		version: "0.1.2",
		availableVersion: undefined,
	});
}, 240_000);
