import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EntryFactory } from "@repo/local-mcp-core/store";
import { NpmConnectors } from "@repo/local-runtime/connector-versions";
import { DesktopManager } from "@repo/local-runtime/manager";
import {
	installNpmPackage,
	npmEnvironment,
	npmMetadata,
	resolveNpmVersion,
	type NpmMetadata,
} from "@repo/local-runtime/npm-source";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) await task();
});

const resources = resolve("resources");
const npmCli = join(resources, "runtimes", "npm", "bin", "npm-cli.js");

/** Dependency-free stdio MCP server; each version exposes its own tools. */
function connectorSource(tools: string[], crash = false) {
	return `#!/usr/bin/env node
import { createInterface } from "node:readline";
${crash ? "process.exit(3);" : ""}
const tools = ${JSON.stringify(tools)};
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	const result =
		request.method === "initialize"
			? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "npm-fixture", version: process.env.npm_package_version ?? "0" } }
			: request.method === "tools/list"
				? { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) }
				: { content: [{ type: "text", text: "ok" }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`;
}

type Registry = { url: string; metadata: NpmMetadata; requests: string[] };
let registry: Registry;
let server: Server;

/** A loopback npm registry serving packed fixture versions. */
beforeAll(async () => {
	const work = await mkdtemp(join(tmpdir(), "npm-registry-"));
	const name = "laplace-npm-fixture";
	const versions: Record<string, { tools: string[]; crash?: boolean }> = {
		"1.0.0": { tools: ["read"] },
		"2.0.0": { tools: ["read", "write"] },
		"3.0.0": { tools: ["read"], crash: true },
	};
	const tarballs = new Map<string, Buffer>();
	const packument: Record<string, unknown> = {
		name,
		"dist-tags": { latest: "2.0.0" },
		versions: {},
	};
	server = createServer((request, response) => {
		registry.requests.push(request.url!);
		const tarball = tarballs.get(request.url!);
		if (tarball) return response.end(tarball);
		if (request.url === `/${name}`) {
			response.setHeader("content-type", "application/json");
			return response.end(JSON.stringify(packument));
		}
		response.statusCode = 404;
		response.end("{}");
	});
	await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	for (const [version, spec] of Object.entries(versions)) {
		const directory = join(work, version);
		await mkdir(join(directory, "bin"), { recursive: true });
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({
				name,
				version,
				type: "module",
				bin: { [name]: "bin/server.js" },
			}),
		);
		await writeFile(
			join(directory, "bin", "server.js"),
			connectorSource(spec.tools, spec.crash),
		);
		execFileSync(process.execPath, [npmCli, "pack", "--silent"], {
			cwd: directory,
		});
		const file = (await readdir(directory)).find((entry) =>
			entry.endsWith(".tgz"),
		)!;
		const bytes = await readFile(join(directory, file));
		const path = `/${name}/-/${name}-${version}.tgz`;
		tarballs.set(path, bytes);
		(packument.versions as Record<string, unknown>)[version] = {
			name,
			version,
			bin: { [name]: "bin/server.js" },
			dist: {
				tarball: url + path,
				integrity:
					"sha512-" +
					createHash("sha512").update(bytes).digest("base64"),
			},
		};
	}
	registry = { url, metadata: packument as NpmMetadata, requests: [] };
	cleanup.length = 0;
	return async () => {
		server.close();
		await rm(work, { recursive: true, force: true });
	};
}, 120_000);

async function managerFixture() {
	const root = await mkdtemp(join(tmpdir(), "npm-connectors-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const secrets = new Map<string, string>();
	const entries: EntryFactory = async (name) => ({
		getPassword: () => secrets.get(name) ?? null,
		setPassword: (value) => void secrets.set(name, value),
		deletePassword: () => void secrets.delete(name),
	});
	const manager = new DesktopManager(
		root,
		resources,
		"https://connect.fixture.invalid",
		{
			entries,
		},
	);
	cleanup.push(() => manager.shutdown());
	await manager.initialize();
	return {
		root,
		manager,
		npm: new NpmConnectors(manager, {
			registry: registry.url,
			requireShrinkwrap: false,
		}),
	};
}

it("resolves exact versions and dist-tags, never ranges, and selects the package command", () => {
	expect(resolveNpmVersion(registry.metadata, "latest").version).toBe(
		"2.0.0",
	);
	expect(resolveNpmVersion(registry.metadata, "1.0.0")).toMatchObject({
		package: "laplace-npm-fixture",
		bin: "laplace-npm-fixture",
	});
	for (const spec of ["^1.0.0", "1", "*", "v1.0.0"])
		expect(() => resolveNpmVersion(registry.metadata, spec)).toThrow(
			"exact published version",
		);
	expect(() => resolveNpmVersion(registry.metadata, "9.9.9")).toThrow(
		"not published",
	);
	expect(() =>
		resolveNpmVersion(registry.metadata, "1.0.0", "other"),
	).toThrow("commands");
});

it("isolates npm from the user's configuration and disables lifecycle scripts", () => {
	const env = npmEnvironment("/root", "/scratch", registry.url);
	expect(env).toMatchObject({
		npm_config_userconfig: join("/scratch", "empty.npmrc"),
		npm_config_globalconfig: join("/scratch", "empty-global.npmrc"),
		npm_config_cache: join("/root", "npm-cache"),
		npm_config_registry: registry.url + "/",
		npm_config_ignore_scripts: "true",
	});
	expect(Object.keys(env).some((key) => /token|auth/i.test(key))).toBe(false);
});

it("rejects unknown packages and Laplace packages published without a shrinkwrap", async () => {
	await expect(
		npmMetadata("missing-package", { registry: registry.url }),
	).rejects.toThrow("not published");
	const root = await mkdtemp(join(tmpdir(), "npm-shrinkwrap-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const source = resolveNpmVersion(registry.metadata, "1.0.0");
	await expect(
		installNpmPackage(source, {
			root,
			resources,
			registry: registry.url,
			requireShrinkwrap: true,
		}),
	).rejects.toThrow("npm-shrinkwrap.json");
	await expect(
		installNpmPackage(
			{
				...source,
				integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
			},
			{
				root,
				resources,
				registry: registry.url,
				requireShrinkwrap: false,
			},
		),
	).rejects.toThrow();
}, 120_000);

it("adds, upgrades, downgrades offline, restores a failing version, and holds new tools", async () => {
	const { manager, npm } = await managerFixture();
	const added = await npm.add({
		id: "fixture",
		name: "Fixture",
		package: "laplace-npm-fixture",
		version: "1.0.0",
		args: ["--flag"],
	});
	expect(added).toMatchObject({ version: "1.0.0", status: "online" });
	const config = manager.getServerConfig("fixture");
	expect(config).toMatchObject({ identity: "npm:laplace-npm-fixture@1.0.0" });
	expect(config.transport === "stdio" && config.args.at(-1)).toBe("--flag");

	expect(await npm.versions("fixture")).toMatchObject({
		current: "1.0.0",
		distTags: { latest: "2.0.0" },
		versions: [
			{ version: "3.0.0" },
			{ version: "2.0.0" },
			{ version: "1.0.0" },
		],
	});

	const upgraded = await npm.setVersion("fixture", "latest");
	expect(upgraded).toMatchObject({
		version: "2.0.0",
		previousVersion: "1.0.0",
		changed: true,
		toolsAwaitingApproval: ["write"],
	});
	const tools = manager.listServers().find((s) => s.id === "fixture")!.tools;
	expect(tools.find((tool) => tool.name === "write")?.localEnabled).toBe(
		false,
	);
	expect(tools.find((tool) => tool.name === "read")?.localEnabled).toBe(true);

	await expect(npm.setVersion("fixture", "3.0.0")).rejects.toThrow(
		"2.0.0 was restored",
	);
	expect(manager.getServerConfig("fixture")).toMatchObject({
		identity: "npm:laplace-npm-fixture@2.0.0",
	});
	expect(manager.listServers().find((s) => s.id === "fixture")?.status).toBe(
		"online",
	);

	// Switching back reuses the verified installation; only metadata is requested.
	registry.requests.length = 0;
	expect(await npm.setVersion("fixture", "1.0.0")).toMatchObject({
		version: "1.0.0",
	});
	expect(registry.requests.filter((path) => path.endsWith(".tgz"))).toEqual(
		[],
	);
	expect(await npm.setVersion("fixture", "1.0.0")).toMatchObject({
		changed: false,
	});
}, 180_000);

it("drops the npm receipt when the launch command is edited by hand", async () => {
	const { manager, npm } = await managerFixture();
	await npm.add({
		id: "fixture",
		name: "Fixture",
		package: "laplace-npm-fixture",
		version: "1.0.0",
	});
	await expect(
		manager.updateServer("fixture", {
			npm: {
				...(manager.getServerConfig("fixture") as { npm: object }).npm,
				version: "2.0.0",
			},
		}),
	).rejects.toThrow("provenance");
	const launch = manager.getServerConfig("fixture") as { args: string[] };
	await manager.updateServer("fixture", {
		args: [...launch.args, "--edited"],
	});
	const config = manager.getServerConfig("fixture");
	expect(config.identity).toBeUndefined();
	expect(config.transport === "stdio" && config.npm).toBeUndefined();
	await expect(npm.versions("fixture")).rejects.toThrow(
		"not installed from npm",
	);
}, 120_000);

it("offers the npm tools to AI clients only when npm connectors are enabled", async () => {
	const names = async (enabled: boolean) => {
		vi.stubEnv("LAPLACE_NPM_CONNECTORS_V1", enabled ? "true" : "");
		vi.resetModules();
		const { connectorManagementTools } =
			await import("@repo/local-runtime/connector-tools");
		return connectorManagementTools.map((tool) => tool.name);
	};
	const npmTools = [
		"local_connectors_add_npm",
		"local_connectors_versions",
		"local_connectors_set_version",
	];
	expect(await names(false)).not.toEqual(
		expect.arrayContaining([npmTools[0]]),
	);
	expect(await names(true)).toEqual(expect.arrayContaining(npmTools));
	vi.unstubAllEnvs();
});
