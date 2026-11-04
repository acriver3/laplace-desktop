import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateRegistration } from "./local-bridge.mjs";

const launcher = fileURLToPath(new URL("./local-bridge.mjs", import.meta.url));
void test("configures and launches the registered bridge with untouched protocol streams and exit status", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-plugin-"));
	try {
		const bridge = join(root, "bridge with spaces.cjs");
		await writeFile(
			bridge,
			'process.stdin.pipe(process.stdout); process.stderr.write("diagnostic"); process.exitCode = 7;',
		);
		const entry = {
			command: process.execPath,
			args: [bridge, "--root", root, "--client-id", "00000000-0000-4000-8000-000000000001"],
		};
		const source = join(root, "registration.json"),
			config = join(root, "saved", "bridge.json");
		await writeFile(source, JSON.stringify(entry));
		const env = { ...process.env, LAPLACE_PLUGIN_BRIDGE_CONFIG: config };
		const configured = spawnSync(process.execPath, [launcher, "--configure", source], {
			env,
			encoding: "utf8",
		});
		assert.equal(configured.status, 0, configured.stderr);
		assert.equal(configured.stdout, "");
		assert.deepEqual(JSON.parse(await readFile(config, "utf8")), entry);
		const message = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
		const result = spawnSync(process.execPath, [launcher], {
			env,
			input: message,
			encoding: "utf8",
		});
		assert.equal(result.stdout, message);
		assert.equal(result.stderr, "diagnostic");
		assert.equal(result.status, 7);
		const missing = spawnSync(process.execPath, [launcher], {
			env: { ...env, LAPLACE_PLUGIN_BRIDGE_CONFIG: join(root, "missing.json") },
			encoding: "utf8",
		});
		assert.equal(missing.status, 1);
		assert.equal(missing.stdout, "");
		assert.match(missing.stderr, /no Laplace login is required/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

void test("rejects non-bridge commands, credentials and malformed registrations", () => {
	const valid = {
		command: process.execPath,
		args: [launcher, "--root", tmpdir(), "--client-id", "00000000-0000-4000-8000-000000000001"],
	};
	for (const value of [
		null,
		{ ...valid, command: "node" },
		{ ...valid, env: { TOKEN: "secret" } },
		{ ...valid, args: ["-e", "arbitrary"] },
		{ ...valid, args: [...valid.args.slice(0, 4), "invalid"] },
	]) {
		assert.throws(() => validateRegistration(value));
	}
});

void test("EOF allows delayed cleanup and forcibly stops a child that ignores shutdown after two seconds", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-plugin-cleanup-"));
	try {
		const bridge = join(root, "bridge.cjs"),
			config = join(root, "config.json");
		await writeFile(
			config,
			JSON.stringify({
				command: process.execPath,
				args: [bridge, "--root", root, "--client-id", "00000000-0000-4000-8000-000000000001"],
			}),
		);
		const env = { ...process.env, LAPLACE_PLUGIN_BRIDGE_CONFIG: config };
		await writeFile(
			bridge,
			'process.stdin.resume(); process.stdin.on("end",()=>setTimeout(()=>{process.stdout.write("flushed");process.exitCode=9},150));',
		);
		const graceful = spawnSync(process.execPath, [launcher], {
			env,
			input: "",
			encoding: "utf8",
			timeout: 5000,
		});
		assert.equal(graceful.stdout, "flushed");
		assert.equal(graceful.status, 9);
		await writeFile(
			bridge,
			'process.stdin.resume(); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000); process.stdout.write(String(process.pid));',
		);
		const started = performance.now();
		const forced = spawnSync(process.execPath, [launcher], {
			env,
			input: "",
			encoding: "utf8",
			timeout: 5000,
		});
		assert.ok(
			performance.now() - started >= 1900,
			"Child did not receive its cleanup grace period",
		);
		assert.notEqual(forced.status, 0);
		assert.ok(!forced.error, String(forced.error));
		assert.throws(() => process.kill(Number(forced.stdout), 0), "Child survived forced cleanup");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

void test("portable and compatibility packages declare both servers consistently", async () => {
	const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
	const portable = await read("../mcp.json"),
		compatibility = await read("../.mcp.json");
	assert.equal(
		(await read("../plugin.json")).version,
		(await read("../.codex-plugin/plugin.json")).version,
		"Portable and Codex packages must advertise the same launcher version",
	);
	assert.deepEqual(Object.keys(portable.mcpServers).sort(), ["laplace", "laplace-local"]);
	assert.deepEqual(portable.mcpServers["laplace-local"], compatibility.mcpServers["laplace-local"]);
	assert.equal(portable.mcpServers.laplace.url, compatibility.mcpServers.laplace.url);
	assert.equal(portable.mcpServers.laplace.url, "https://connect.withlaplace.com/mcp");
});
