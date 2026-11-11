import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, cp, chmod, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserAssets } from "../../../packages/browser-runtime/src/build-assets.mjs";
import { verifyBrowserRuntime } from "../../../packages/browser-runtime/scripts/verify-source.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const { build } = require("esbuild");
const version = JSON.parse(await readFile(join(desktop, "package.json"), "utf8")).version;
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const targets = ["linux-x64", "win32-x64", "darwin-arm64", "darwin-x64"];
if (!targets.includes(target)) throw new Error("Unsupported runtime target");
const [platform, arch] = target.split("-");
const out = join(root, "apps/local-mcp/dist/npm");
const runtime = join(out, target);
const cli = join(out, "cli");
const run = (file, args, options = {}) =>
	execFileSync(file, args, { stdio: "inherit", windowsHide: true, ...options });
const json = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
await mkdir(out, { recursive: true });
await verifyBrowserRuntime();
run(process.execPath, [join(root, "packages/project-protocol/scripts/build-mcp-ui.mjs")]);
await mkdir(runtime, { recursive: true });
await mkdir(cli, { recursive: true });
const common = {
	platform: "node",
	format: "cjs",
	target: "node24",
	bundle: true,
	external: ["@napi-rs/keyring"],
	logLevel: "info",
};
await build({
	...common,
	absWorkingDir: root,
	entryPoints: [
		"packages/local-runtime/src/service.ts",
		"packages/local-runtime/src/bridge.ts",
		"packages/local-runtime/src/slack-browser.ts",
		{ in: "apps/local-mcp/src/main.ts", out: "launcher" },
	],
	outdir: join(runtime, "helper"),
	outExtension: { ".js": ".cjs" },
});
await build({
	...common,
	entryPoints: [join(root, "apps/local-mcp/src/npm-entry.ts")],
	outfile: join(cli, "bin/laplace.cjs"),
});
await chmod(join(cli, "bin/laplace.cjs"), 0o755);
await buildBrowserAssets(build, runtime, platform, arch);
await rm(join(runtime, "plugin"), { recursive: true, force: true });
await cp(join(root, "plugins/laplace"), join(runtime, "plugin"), {
	recursive: true,
	filter: (path) => !path.endsWith(".test.mjs"),
});
await cp(join(desktop, "runtime-manifests/bitwarden"), join(runtime, "bitwarden"), {
	recursive: true,
});
await writeFile(join(runtime, "VERSION"), version);
const native = `@napi-rs/keyring-${platform}-${arch}${platform === "win32" ? "-msvc" : platform === "linux" ? "-gnu" : ""}`;
const metadata = {
	version,
	license: "Apache-2.0",
	repository: { type: "git", url: "git+https://github.com/acriver3/laplace-desktop.git" },
	publishConfig: { access: "public" },
};
await json(join(runtime, "package.json"), {
	...metadata,
	name: `@withlaplace/runtime-${target}`,
	description: `Standalone Laplace Runtime for ${target}`,
	os: [platform],
	cpu: [arch],
	...(platform === "linux" ? { libc: ["glibc"] } : {}),
	files: [
		"helper",
		"runtimes",
		"plugin",
		"bitwarden",
		"browser-extension",
		"*.json",
		"VERSION",
		"LICENSE",
	],
	dependencies: { "@napi-rs/keyring": "2.1.0", [native]: "2.1.0" },
	bundledDependencies: ["@napi-rs/keyring", native],
});
run(
	"npm",
	[
		"install",
		...(platform !== process.platform || arch !== process.arch ? ["--force"] : []),
		"--omit=dev",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--package-lock=false",
		`--os=${platform}`,
		`--cpu=${arch}`,
		"--libc=glibc",
	],
	{ cwd: runtime },
);
const preparation = [
	join(root, "apps/local-mcp/scripts/prepare-runtimes.mjs"),
	target,
	join(runtime, "runtimes"),
];
if (platform === "win32" && process.platform !== "win32") {
	const nativeDir = process.env.LAPLACE_WINDOWS_NATIVE_DIR;
	if (!nativeDir)
		throw new Error("Set LAPLACE_WINDOWS_NATIVE_DIR to freshly compiled Windows native helpers");
	preparation.push(join(nativeDir, "process-host.exe"));
}
run(process.execPath, preparation);
if (platform === "win32") {
	if (process.platform === "win32") {
		const csc = join(
			process.env.SystemRoot || "C:\\Windows",
			"Microsoft.NET/Framework64/v4.0.30319/csc.exe",
		);
		for (const [name, source, kind] of [
			["browser-native-host", join(runtime, "helper/browser-native-host.cs"), "exe"],
			["laplace-runtime-hidden", join(desktop, "native/runtime-hidden.cs"), "winexe"],
		])
			run(csc, [
				"/nologo",
				`/target:${kind}`,
				`/out:${join(runtime, "runtimes", name + ".exe")}`,
				source,
			]);
	} else {
		for (const name of ["browser-native-host", "laplace-runtime-hidden"])
			await cp(
				join(process.env.LAPLACE_WINDOWS_NATIVE_DIR, name + ".exe"),
				join(runtime, "runtimes", name + ".exe"),
			);
	}
}
await json(join(cli, "package.json"), {
	...metadata,
	name: "@withlaplace/cli",
	description: "Manage Laplace connectors and AI clients from your terminal",
	engines: { node: ">=24" },
	bin: {
		laplace: "bin/laplace.cjs",
		"laplace-local": "bin/laplace.cjs",
		"laplace-runtime": "bin/laplace.cjs",
	},
	files: ["bin", "README.md", "LICENSE"],
	dependencies: { "@napi-rs/keyring": "2.1.0" },
	optionalDependencies: Object.fromEntries(
		targets.map((t) => [`@withlaplace/runtime-${t}`, version]),
	),
});
for (const directory of [runtime, cli]) await cp(join(root, "LICENSE"), join(directory, "LICENSE"));
await cp(join(root, "apps/local-mcp/README.md"), join(cli, "README.md"));
console.log(JSON.stringify({ runtime, cli, version, target }));
