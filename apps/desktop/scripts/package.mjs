import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleRuntime } from "./runtime-tree.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
if (!["darwin", "win32"].includes(process.platform))
	throw new Error("Desktop test packages currently target macOS and Windows.");
execFileSync(process.execPath, ["scripts/runtimes.mjs"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
const require = createRequire(import.meta.url);
const stage = join(root, ".cache/package");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
// This staging tree is already a flat, self-contained runtime dependency tree.
// Keep Forge's pnpm requirement local; do not change the monorepo's linker.
await writeFile(join(stage, ".npmrc"), "node-linker=hoisted\n");
await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
await assembleRuntime(root, join(root, ".cache/runtime"));
await cp(join(root, "forge.config.cjs"), join(stage, "forge.config.cjs"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
	join(stage, "package.json"),
	JSON.stringify(
		{
			name: "laplace-desktop",
			productName: "Laplace",
			version: pkg.version,
			description: pkg.description,
			author: pkg.author,
			main: pkg.main,
			config: { forge: "./forge.config.cjs" },
			devDependencies: { electron: pkg.devDependencies.electron },
		},
		null,
		2,
	),
);
const forgePackage = require.resolve("@electron-forge/cli/package.json");
const forge = JSON.parse(await readFile(forgePackage, "utf8"));
const cli = join(
	dirname(forgePackage),
	typeof forge.bin === "string" ? forge.bin : forge.bin["electron-forge"],
);
execFileSync(process.execPath, [cli, process.argv.includes("--make") ? "make" : "package"], {
	cwd: stage,
	stdio: "inherit",
	env: { ...process.env, LAPLACE_DESKTOP_BUILD_ROOT: root },
});
if (process.platform === "darwin") {
	const app = join(root, "out", `Laplace-darwin-${process.arch}`, "Laplace.app");
	execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
	if (!process.env.LAPLACE_MAC_SIGN_IDENTITY)
		console.log(
			"Locally signed macOS build. Set LAPLACE_MAC_SIGN_IDENTITY to a Developer ID Application identity for release signing.",
		);
}
