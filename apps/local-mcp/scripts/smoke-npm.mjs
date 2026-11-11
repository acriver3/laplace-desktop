import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const [cliTar, runtimeTar] = process.argv.slice(2).map((p) => resolve(p));
if (!cliTar || !runtimeTar) throw Error("Provide CLI and native runtime npm tarballs");
const root = mkdtempSync(join(tmpdir(), "laplace-npm-smoke-"));
const home = join(root, "home");
mkdirSync(home);
const env = {
	...process.env,
	HOME: home,
	USERPROFILE: home,
	APPDATA: join(home, "roaming"),
	LOCALAPPDATA: join(home, "local"),
	XDG_CONFIG_HOME: join(home, "config"),
	XDG_DATA_HOME: join(home, "data"),
	LAPLACE_RUNTIME_HOME: join(root, "runtime"),
	LAPLACE_RUNTIME_ROOT: join(root, "profile"),
};
mkdirSync(env.APPDATA, { recursive: true });
mkdirSync(env.LOCALAPPDATA, { recursive: true });
const prefix = join(root, "npm");
const npm = process.platform === "win32" ? process.env.LAPLACE_SMOKE_NPM_CLI : undefined;
if (process.platform === "win32" && !npm) throw Error("Set LAPLACE_SMOKE_NPM_CLI to npm-cli.js");
execFileSync(
	npm ? process.execPath : "npm",
	[
		...(npm ? [npm] : []),
		"install",
		"--prefix",
		prefix,
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--omit=optional",
		cliTar,
		runtimeTar,
	],
	{ stdio: "inherit", windowsHide: true },
);
const cli = join(prefix, "node_modules/@withlaplace/cli/bin/laplace.cjs");
function command(...args) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		env,
		encoding: "utf8",
		timeout: 60000,
		windowsHide: true,
	});
	assert.equal(result.status, 0, result.stderr + result.stdout);
	return result.stdout.trim();
}
assert.equal(command("--version"), "0.1.49");
assert.match(command("--help"), /connectors/);
const absent = spawnSync(process.execPath, [cli, "status"], { env, encoding: "utf8" });
assert.notEqual(absent.status, 0);
assert.match(absent.stderr, /setup/);
assert.equal(JSON.parse(command("setup")).installed, "0.1.49");
assert.equal(JSON.parse(command("status")).running, false);
assert.equal(JSON.parse(command("doctor")).keychain, true);
try {
	const first = JSON.parse(command("start", "--no-native-host"));
	assert.equal(first.running, true);
	const second = JSON.parse(command("start", "--no-native-host"));
	assert.equal(second.pid, first.pid, "CLI must reuse the existing runtime");
	assert.deepEqual(JSON.parse(command("connectors", "list")), []);
	assert.deepEqual(JSON.parse(command("clients", "list")), []);
	assert.equal(JSON.parse(command("runtime", "info")).version, "0.1.49");
	const client = JSON.parse(command("clients", "register", "npm smoke", "--confirm"));
	assert.ok(client.id);
	command("clients", "permissions", client.id, "--tools", "none", "--confirm");
	command("clients", "revoke", client.id, "--confirm");
	assert.ok(Array.isArray(JSON.parse(command("jobs", "list"))));
	// Real persisted custom connector, disabled until explicitly started; no provider traffic.
	const fixture = join(root, "connector.json");
	writeFileSync(
		fixture,
		JSON.stringify({
			id: "npm-smoke",
			name: "npm smoke",
			transport: "stdio",
			command: process.execPath,
			args: ["-e", "process.stdin.resume()"],
			enabled: false,
		}),
	);
	command("connectors", "add", "--config", fixture, "--confirm");
	assert.equal(JSON.parse(command("connectors", "show", "npm-smoke")).id, "npm-smoke");
	command("connectors", "permissions", "npm-smoke", "--tools", "none", "--confirm");
	command("connectors", "remove", "npm-smoke", "--confirm");
	assert.deepEqual(JSON.parse(command("connectors", "list")), []);
} finally {
	command("stop");
}
assert.equal(JSON.parse(command("status")).running, false);
const receipt = {
	platform: process.platform,
	arch: process.arch,
	version: command("--version"),
	root,
	passed: true,
};
writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
