import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeCommand, serverConfig } from "@repo/local-mcp-core/config";
import { afterEach, expect, it } from "vitest";

import {
	previewImportFile,
	previewLaunch,
	previewManualConfiguration,
} from "@repo/local-runtime/imports";

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "laplace-launch-review-"));
	folders.push(root);
	const resources = join(root, "resources"),
		cwd = join(root, "working");
	await mkdir(join(resources, "runtimes", "npm", "bin"), { recursive: true });
	await mkdir(cwd);
	return { root, resources, cwd, environment: {} };
}

it("reviews bundled Node/npm/npx/uvx launch paths and arguments without executing them", async () => {
	const f = await fixture();
	for (const name of ["npm", "npx"])
		await writeFile(
			join(f.resources, "runtimes", "npm", "bin", `${name}-cli.js`),
			"throw Error('This preview must never execute');",
		);
	await writeFile(
		join(f.resources, "runtimes", process.platform === "win32" ? "uv.exe" : "uv"),
		"This fixture must not execute",
		{ mode: 0o700 },
	);
	for (const command of ["node", "npm", "npx", "uvx"]) {
		const config = serverConfig.parse({
			id: "review",
			name: "Review",
			transport: "stdio",
			command,
			args: ["some-package", "--token", "synthetic-private-value"],
		});
		const preview = await previewLaunch(config, f);
		const expected = runtimeCommand(
			command,
			config.transport === "stdio" ? config.args : [],
			f.resources,
		);
		expect(preview.error).toBeUndefined();
		expect(preview.resolvedCommand).toBe(
			command === "uvx"
				? join(f.resources, "runtimes", process.platform === "win32" ? "uv.exe" : "uv")
				: process.execPath,
		);
		expect(preview.resolvedArgs).toEqual([...expected.args.slice(0, -1), "••••"]);
		expect(preview.resolvedDirectory).toBe(join(f.root, "servers", "review"));
		expect(JSON.stringify(preview)).not.toContain("synthetic-private-value");
	}
});

it("finds a custom executable through cwd/PATH and reports missing files before activation", async () => {
	const f = await fixture(),
		binary = join(f.cwd, process.platform === "win32" ? "review-fixture.exe" : "review-fixture");
	await writeFile(binary, "This fixture must not execute", { mode: 0o700 });
	const config = serverConfig.parse({
		id: "review",
		name: "Review",
		transport: "stdio",
		command: "review-fixture",
		cwd: f.cwd,
	});
	const preview = await previewLaunch(config, { ...f, environment: { PATH: f.cwd } });
	expect(preview.resolvedCommand).toBe(binary);
	expect(preview.resolvedDirectory).toBe(f.cwd);
	expect(preview.error).toBeUndefined();
	await rm(binary);
	expect((await previewLaunch(config, { ...f, environment: { PATH: f.cwd } })).error).toContain(
		"executable",
	);
	await rm(f.cwd, { recursive: true });
	expect((await previewLaunch(config, f)).error).toContain("working directory");
});

it("checks the bundled npm entry point as well as its Node executable", async () => {
	const f = await fixture();
	const config = serverConfig.parse({
		id: "review",
		name: "Review",
		transport: "stdio",
		command: "npm",
		args: ["exec", "some-package"],
	});
	const preview = await previewLaunch(config, f);
	expect(preview.resolvedCommand).toBe(process.execPath);
	expect(preview.error).toContain("npm runtime is incomplete");
});

it("merges an edit with stored credentials privately and returns only a redacted review", async () => {
	const f = await fixture();
	const previous = serverConfig.parse({
		id: "review",
		name: "Existing",
		transport: "stdio",
		command: "node",
		args: ["server.mjs", "--password", "synthetic-private-argument"],
		env: { API_TOKEN: "synthetic-private-env" },
		enabled: false,
	});
	const preview = await previewManualConfiguration({ name: "Renamed" }, f, previous);
	expect(preview).toMatchObject({
		id: "review",
		name: "Renamed",
		enabled: false,
		secretKeys: ["API_TOKEN"],
		resolvedCommand: process.execPath,
		resolvedArgs: ["server.mjs", "--password", "••••"],
	});
	expect(JSON.stringify(preview)).not.toContain("synthetic-private");
	expect(previous.transport === "stdio" && previous.env.API_TOKEN).toBe("synthetic-private-env");
});

it("adds resolved launch details to file import review while preserving the source", async () => {
	const f = await fixture(),
		file = join(f.root, "mcp.json");
	const source = JSON.stringify({
		mcpServers: {
			good: { command: "node", args: ["server.mjs"] },
			missing: { command: "definitely-missing-laplace-preview-executable" },
		},
	});
	await writeFile(file, source);
	const preview = await previewImportFile(file, f);
	expect(preview.entries[0]?.resolvedCommand).toBe(process.execPath);
	expect(preview.entries[0]?.resolvedDirectory).toBe(join(f.root, "servers", "good"));
	expect(preview.entries[1]?.error).toContain("executable");
	expect(await readFile(file, "utf8")).toBe(source);
});
