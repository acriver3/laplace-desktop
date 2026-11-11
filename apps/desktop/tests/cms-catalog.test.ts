import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
	CatalogInstaller,
	catalogConfiguration,
	npmCatalogConfig,
} from "@repo/local-runtime/catalog";
import { bundleCatalog } from "@repo/local-runtime/library-catalog";
import { DesktopManager } from "@repo/local-runtime/manager";
import { npmPackageDirectory } from "@repo/local-runtime/npm-source";
import { afterEach, expect, it, vi } from "vitest";

const cms = bundleCatalog.find((entry) => entry.recipe === "yale-som-cms")!;
const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
const source = {
	package: cms.npm!.package,
	version: cms.version,
	bin: cms.npm!.bin,
	integrity,
};
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) await task();
	vi.unstubAllEnvs();
});

it("resolves CMS profile, browser and downloads without allowing state inside the package", () => {
	const root = join(tmpdir(), "cms-state");
	const packages = join(root, "npm-packages");
	const configuration = catalogConfiguration(cms, {}, root, packages);
	expect(configuration).toEqual({
		profile_dir: join(root, "sessions", "yale-som-cms", "profile"),
		browser: "chrome",
		downloads_dir: join(homedir(), "Documents", "Yale SOM CMS"),
	});
	const config = npmCatalogConfig(
		cms,
		source,
		{ command: "node", args: [join(packages, "dist", "cli.js")] },
		configuration,
		packages,
	);
	expect(config).toMatchObject({
		id: "yale-som-cms",
		name: "Yale SOM CMS [Background Browser]",
		enabled: false,
		args: [
			join(packages, "dist", "cli.js"),
			"serve",
			"--profile-dir",
			configuration.profile_dir,
			"--browser",
			"chrome",
			"--downloads-dir",
			configuration.downloads_dir,
		],
		identity: "npm:@withlaplace/yale-som-cms-mcp@0.1.0",
	});
	for (const key of ["profile_dir", "downloads_dir"])
		expect(() =>
			catalogConfiguration(cms, { [key]: join(packages, "private") }, root, packages),
		).toThrow("outside");
	expect(() => catalogConfiguration(cms, { browser: "firefox" }, root, packages)).toThrow();
	expect(JSON.stringify(config)).not.toContain("${");
});

it("authenticates CMS with the configured browser and runs only its approved setup reads", async () => {
	vi.stubEnv("LAPLACE_SESSION_RECOVERY_V1", "false");
	// Enable the unpublished fixture on the test host; this is not platform acceptance.
	const original = { published: cms.published, candidate: cms.candidate, platforms: cms.platforms };
	cms.published = true;
	cms.candidate = true;
	cms.platforms = [`${process.platform}-${process.arch}` as never];
	cleanup.push(() => Object.assign(cms, original));
	const root = await mkdtemp(join(tmpdir(), "cms-catalog-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const resources = join(root, "resources");
	const directory = npmPackageDirectory(root, source);
	const packageDirectory = join(directory, "node_modules", ...source.package.split("/"));
	const file = "dist/cli.js";
	const log = join(root, "fixture.jsonl");
	const failLogin = join(root, "fail-login");
	await mkdir(join(packageDirectory, "dist"), { recursive: true });
	await writeFile(
		join(packageDirectory, "package.json"),
		JSON.stringify({
			name: source.package,
			version: source.version,
			type: "module",
			bin: { [source.bin]: file },
		}),
	);
	await writeFile(
		join(directory, ".laplace-npm.json"),
		JSON.stringify({ package: source.package, version: source.version, integrity }),
	);
	await writeFile(
		join(packageDirectory, file),
		`import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
appendFileSync(log, JSON.stringify({ args }) + "\\n");
if (args[0] === "login") process.exit(existsSync(${JSON.stringify(failLogin)}) ? 1 : 0);
const tools = ["cms_session_status", "cms_get_dashboard", "cms_list_jobs"];
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	if (request.method === "tools/call")
		appendFileSync(log, JSON.stringify({ tool: request.params.name }) + "\\n");
	const result = request.method === "initialize"
		? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "cms-fixture", version: "0" } }
		: request.method === "tools/list"
			? { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) }
			: { content: [{ type: "text", text: JSON.stringify({ authenticated: true }) }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
	);
	const secrets = new Map<string, string>();
	const manager = new DesktopManager(root, resources, "https://connect.fixture.invalid", {
		entries: async (key) => ({
			getPassword: () => secrets.get(key) ?? null,
			setPassword: (value) => void secrets.set(key, value),
			deletePassword: () => void secrets.delete(key),
		}),
	});
	cleanup.push(() => manager.shutdown());
	await manager.initialize();
	const installer = new CatalogInstaller(manager, {
		root,
		resources,
		nodePath: process.execPath,
		fetch: async () =>
			Response.json({
				name: source.package,
				"dist-tags": { latest: source.version },
				versions: {
					[source.version]: { bin: { [source.bin]: file }, dist: { integrity } },
				},
			}),
	});
	const configuration = {
		profile_dir: join(root, "sessions", "cms", "profile"),
		browser: "msedge",
		downloads_dir: join(root, "downloads"),
	};
	const install = await installer.install({ catalogId: cms.id, configuration });
	await vi.waitFor(() =>
		expect(installer.jobs().find((job) => job.id === install.id)).toMatchObject({
			status: "completed",
		}),
	);
	const auth = await installer.authenticate("yale-som-cms");
	await vi.waitFor(() =>
		expect(installer.jobs().find((job) => job.id === auth.id)?.status).toBe("completed"),
	);
	const observations = (await readFile(log, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(observations.find((item) => item.args?.[0] === "login")).toEqual({
		args: [
			"login",
			"--profile-dir",
			configuration.profile_dir,
			"--browser",
			"msedge",
			"--downloads-dir",
			configuration.downloads_dir,
		],
	});
	expect(observations.flatMap((item) => (item.tool ? [item.tool] : []))).toEqual([
		"cms_session_status",
		"cms_get_dashboard",
	]);
	await expect(
		manager.catalogSetupCall("yale-som-cms", "cms_list_jobs", {}, new AbortController().signal),
	).rejects.toThrow("named setup checks");
	await expect(
		manager.catalogSetupCall(
			"yale-som-cms",
			"cms_get_dashboard",
			{ unexpected: true },
			new AbortController().signal,
		),
	).rejects.toThrow("named setup checks");
	await writeFile(failLogin, "fail");
	const failure = await installer.authenticate("yale-som-cms");
	await vi.waitFor(() =>
		expect(installer.jobs().find((job) => job.id === failure.id)?.status).toBe("failed"),
	);
	expect(manager.getServerConfig("yale-som-cms").enabled).toBe(false);
});
