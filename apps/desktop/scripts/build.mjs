import { execFileSync } from "node:child_process";
import { mkdir, copyFile, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { build as buildRenderer } from "vite";

import { verifyBrowserRuntime } from "../../../packages/browser-runtime/scripts/verify-source.mjs";
import { buildBrowserAssets } from "../../../packages/browser-runtime/src/build-assets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
execFileSync(
	process.execPath,
	[resolve(root, "../../packages/project-protocol/scripts/build-mcp-ui.mjs")],
	{ stdio: "inherit" },
);
await verifyBrowserRuntime();
await mkdir("dist/main", { recursive: true });
await build({
	entryPoints: [
		"src/main/index.ts",
		"src/main/preload.ts",
		"src/main/web-preload.ts",
		"src/main/point-preload.ts",
	],
	outdir: "dist/main",
	outExtension: { ".js": ".cjs" },
	platform: "node",
	format: "cjs",
	target: "node24",
	bundle: true,
	external: ["electron", "@napi-rs/keyring"],
	logLevel: "info",
});
// Removed entry points must not linger in packaged runtimes from earlier builds.
await rm("dist/helper", { recursive: true, force: true });
await build({
	entryPoints: [
		"../../packages/local-runtime/src/service.ts",
		"../../packages/local-runtime/src/bridge.ts",
		"../../packages/local-runtime/src/slack-browser.ts",
		{ in: "../local-mcp/src/main.ts", out: "launcher" },
	],
	outdir: "dist/helper",
	outExtension: { ".js": ".cjs" },
	platform: "node",
	format: "cjs",
	target: "node24",
	bundle: true,
	external: ["@napi-rs/keyring"],
	logLevel: "info",
});
await build({
	entryPoints: ["src/update/entry.ts"],
	outfile: "dist/update/cli.cjs",
	platform: "node",
	format: "cjs",
	target: "node24",
	bundle: true,
});
await buildRenderer({ configFile: resolve(root, "vite.config.ts") });
await mkdir("dist/licenses", { recursive: true });
await copyFile("../connector/app/fonts/inter-OFL.txt", "dist/licenses/inter-OFL.txt");
await mkdir("resources", { recursive: true });
await copyFile("../../packages/ui/brand/app-icon.svg", "resources/icon.svg");
await import("./icons.mjs");

await cp("../../packages/browser-runtime/extension", "resources/browser-extension", {
	recursive: true,
});
// Development uses resources directly; packaged builds copy dist/helper here too.
await mkdir("resources/helper", { recursive: true });
await copyFile("dist/helper/slack-browser.cjs", "resources/helper/slack-browser.cjs");
await buildBrowserAssets(build, resolve("resources"));
await copyFile("resources/helper/yc-browser.cjs", "dist/helper/yc-browser.cjs");
await copyFile("resources/helper/browser-native-entry.cjs", "dist/helper/browser-native-entry.cjs");

if (process.platform === "win32") {
	await mkdir("resources/runtimes", { recursive: true });
	execFileSync(
		join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
		[
			"/nologo",
			"/target:exe",
			"/out:" + resolve("resources/runtimes/browser-native-host.exe"),
			resolve("resources/helper/browser-native-host.cs"),
		],
		{ stdio: "inherit", windowsHide: true },
	);
	// Windowless login launcher: the Run key must not flash a console window.
	execFileSync(
		join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
		[
			"/nologo",
			"/target:winexe",
			"/out:" + resolve("resources/runtimes/laplace-runtime-hidden.exe"),
			resolve("native/runtime-hidden.cs"),
		],
		{ stdio: "inherit", windowsHide: true },
	);
}
