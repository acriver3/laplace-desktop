// Exercise the same updater bundle in Node and Electron against a real ASAR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "laplace-update-filesystem-"));
try {
	const fixture = join(scratch, "fixture");
	await mkdir(fixture);
	const resources = process.platform === "darwin"
		? join(dirname(electron), "../Resources")
		: join(dirname(electron), "resources");
	await cp(join(resources, "default_app.asar"), join(fixture, "app.asar"));
	const runner = join(scratch, "check.cjs");
	await build({
		stdin: {
			resolveDir: root,
			contents: `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, lstat, rm, open } from './src/update/filesystem';
import { packageDigest } from './src/update/common';
const [source, target] = process.argv.slice(2);
(async () => {
	const before = await packageDigest(source);
	await cp(source, target, { recursive: true, verbatimSymlinks: true });
	assert.equal((await lstat(target + '/app.asar')).isFile(), true);
	assert.equal(await packageDigest(target), before);
	const file = await open(target + '/app.asar', 'a');
	await file.write(Buffer.from('changed'));
	await file.close();
	assert.notEqual(await packageDigest(target), before);
	await rm(target, { recursive: true, force: true });
	await assert.rejects(lstat(target), { code: 'ENOENT' });
	console.log('DIGEST:' + before);
})().then(() => {
	if (process.versions.electron) createRequire(process.execPath)('electron').app.exit(0);
}).catch(error => {
	console.error(error);
	if (process.versions.electron) createRequire(process.execPath)('electron').app.exit(1);
	else process.exitCode = 1;
});`,
		},
		outfile: runner, platform: "node", format: "cjs", bundle: true,
	});
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const run = (executable, name) => execFileSync(executable, [runner, fixture, join(scratch, name)], {
		env, encoding: "utf8", timeout: 60_000,
	});
	const node = run(process.execPath, "node-copy");
	const native = run(electron, "electron-copy");
	assert.equal(native.match(/DIGEST:([a-f0-9]+)/)?.[1], node.match(/DIGEST:([a-f0-9]+)/)?.[1]);
	assert.match(node, /DIGEST:[a-f0-9]{64}/);
	console.log("Node and Electron copied, hashed, detected tampering, and removed the ASAR package identically.");
} finally {
	await rm(scratch, { recursive: true, force: true });
}
