import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const output = join(root, "apps/desktop/dist/update/cli.cjs");
await build({
	entryPoints: [join(root, "apps/desktop/src/update/entry.ts")],
	outfile: output,
	platform: "node",
	format: "cjs",
	target: "node24",
	bundle: true,
});
const args = process.argv.slice(2).filter((value) => value !== "--");
const command =
	args[0] === "--recover"
		? ["recover"]
		: args[0] === "--release"
			? ["release", root, ...args.slice(1)]
			: ["install", root, ...args];
execFileSync(process.execPath, [output, ...command], { stdio: "inherit" });
