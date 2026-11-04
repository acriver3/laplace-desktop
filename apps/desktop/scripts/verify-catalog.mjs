import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

if (!process.argv[2])
	throw new Error(
		"Pass a directory containing the four pinned .mcpb files. This check never launches connectors or signs in.",
	);
const root = fileURLToPath(new URL("..", import.meta.url));
await mkdir(join(root, ".cache"), { recursive: true });
const output = join(root, ".cache/catalog-artifacts.cjs");
await build({
	entryPoints: [join(root, "tests/catalog-artifacts.integration.ts")],
	outfile: output,
	platform: "node",
	format: "cjs",
	target: "node24",
	bundle: true,
	external: ["@napi-rs/keyring"],
	logLevel: "warning",
});
execFileSync(process.execPath, [output, resolve(process.argv[2])], { cwd: root, stdio: "inherit" });
