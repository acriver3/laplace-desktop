import { execFileSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const packaged = process.argv.includes("--packaged");
const packageRoot = join(root, "out", `Laplace-${process.platform}-${process.arch}`);
const resources = packaged
	? join(
			packageRoot,
			...(process.platform === "darwin"
				? ["Laplace.app", "Contents", "Resources", "runtime"]
				: ["resources", "runtime"]),
		)
	: join(root, "resources");
const bridge = packaged
	? join(resources, "helper/bridge.cjs")
	: join(root, "dist/helper/bridge.cjs");
const runtime = join(resources, "runtimes", process.platform === "win32" ? "node.exe" : "node");
await access(runtime);
await access(bridge);
const keyring = packaged ? createRequire(bridge).resolve("@napi-rs/keyring") : undefined;
if (keyring && !keyring.startsWith(join(resources, "node_modules") + sep))
	throw new Error("Packaged keyring resolved outside the application runtime.");
await mkdir(join(root, ".cache"), { recursive: true });
const output = join(root, ".cache/native-smoke.cjs");
await build({
	entryPoints: [join(root, "tests/native.integration.ts")],
	outfile: output,
	platform: "node",
	format: "cjs",
	target: "node24",
	bundle: true,
	external: keyring ? [] : ["@napi-rs/keyring"],
	plugins: keyring
		? [
				{
					name: "packaged-keyring",
					setup(build) {
						build.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({
							path: pathToFileURL(keyring).href,
							external: true,
						}));
					},
				},
			]
		: [],
	logLevel: "warning",
});
execFileSync(runtime, [output, root, resources, bridge, packaged ? "packaged" : "development"], {
	cwd: root,
	stdio: "inherit",
	// The stress proof launches 100 sequential and 32 concurrent real bridge processes.
	// Keep per-operation deadlines in the fixture, with room for slower Intel runners.
	timeout: 300000,
});
