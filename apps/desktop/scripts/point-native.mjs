import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { windowsCompilerEnvironment } from "../../local-mcp/scripts/windows-prerequisites.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(
	root,
	"resources/point",
	process.platform === "win32" ? "point-native.exe" : "point-native",
);
if (!["win32", "darwin"].includes(process.platform))
	throw new Error("Build Point’s native adapter on Windows or macOS.");
mkdirSync(dirname(output), { recursive: true });
mkdirSync(join(root, ".cache/point-native"), { recursive: true });
if (process.platform === "win32") {
	execFileSync(
		"cl.exe",
		[
			"/nologo",
			"/std:c++17",
			"/EHsc",
			"/O2",
			"/MT",
			join(root, "native/point-win.cpp"),
			`/Fe:${output}`,
			"ole32.lib",
			"oleaut32.lib",
			"user32.lib",
			"version.lib",
			"uiautomationcore.lib",
			"/link",
			"/SUBSYSTEM:CONSOLE",
		],
		{
			cwd: join(root, ".cache/point-native"),
			stdio: "inherit",
			windowsHide: true,
			env: windowsCompilerEnvironment(),
		},
	);
} else {
	const compile = (source, destination) =>
		execFileSync(
			"xcrun",
			[
				"clang++",
				"-std=c++17",
				"-fobjc-arc",
				"-O2",
				source,
				"-framework",
				"AppKit",
				"-framework",
				"ApplicationServices",
				"-o",
				destination,
			],
			{ stdio: "inherit" },
		);
	compile(join(root, "native/point-mac.mm"), output);
	if (process.argv.includes("--test")) {
		const test = join(root, ".cache/point-native/point-mac-test");
		compile(join(root, "tests/point-mac.test.mm"), test);
		execFileSync(test, [], { stdio: "inherit" });
	}
}
console.log(`Built Point adapter for ${process.platform}-${process.arch}.`);
