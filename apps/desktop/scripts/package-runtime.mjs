import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleRuntime } from "./runtime-tree.mjs";

// Headless Laplace Runtime archive: the same runtime tree Desktop embeds, without Electron.
const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
const target = `${process.platform}-${process.arch}`;
if (!["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"].includes(target))
	throw new Error(`Unsupported runtime target: ${target}`);
if (!process.argv.includes("--skip-build")) {
	execFileSync(process.execPath, ["scripts/runtimes.mjs"], { stdio: "inherit" });
	execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
}
const output = join(root, ".cache/runtime-headless");
await rm(output, { recursive: true, force: true });
const name = "laplace-runtime";
const tree = join(output, name);
const version = await assembleRuntime(root, tree);
const windows = process.platform === "win32";
await writeFile(
	join(tree, windows ? "install.cmd" : "install.sh"),
	windows
		? '@echo off\r\n"%~dp0runtimes\\node.exe" "%~dp0helper\\launcher.cjs" install %*\r\n'
		: '#!/bin/sh\nset -e\nhere="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$here/runtimes/node" "$here/helper/launcher.cjs" install "$@"\n',
	{ mode: 0o755 },
);
await writeFile(
	join(tree, "README.txt"),
	`Laplace Runtime ${version} (${target})

Run ${windows ? "install.cmd" : "./install.sh"} to install into your user profile, start the
runtime, and start it at login. Use --no-autostart to skip login start.
Afterwards use the stable launcher printed by the installer:
  laplace-runtime status | start | stop | enable | disable
`,
);
await mkdir(join(root, ".cache/runtime-release"), { recursive: true });
const archive = join(
	root,
	".cache/runtime-release",
	`laplace-runtime-${version}-${target}.${windows ? "zip" : "tar.gz"}`,
);
await rm(archive, { force: true });
if (windows)
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Compress-Archive -Path '${tree}' -DestinationPath '${archive}'`,
		],
		{ stdio: "inherit" },
	);
else execFileSync("tar", ["-czf", archive, "-C", output, name], { stdio: "inherit" });
const sha256 = createHash("sha256")
	.update(await readFile(archive))
	.digest("hex");
await writeFile(
	`${archive}.manifest.json`,
	JSON.stringify({ name: "laplace-runtime", version, target, sha256 }, null, 2) + "\n",
);
console.log(JSON.stringify({ archive, sha256 }));
