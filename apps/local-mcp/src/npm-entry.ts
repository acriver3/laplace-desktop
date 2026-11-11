#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { currentRuntime, installRuntime } from "@repo/local-runtime/install";
import { runtimeProfile, profileRoot, runtimeProfiles } from "@repo/local-runtime/paths";
import { swapRunningRuntime } from "@repo/local-runtime/update";
import { runCli } from "./cli";
import { cliIo } from "./io";
import pkg from "../../desktop/package.json";

export async function runNpm(argv = process.argv.slice(2)) {
	const installed = await currentRuntime();
	if (argv[0] === "setup") {
		const target = `${process.platform}-${process.arch}`;
		const require = createRequire(__filename);
		let directory: string;
		try {
			directory = dirname(require.resolve(`@withlaplace/runtime-${target}/package.json`));
		} catch {
			throw new Error(
				`No standalone runtime for ${target} is installed. Install the matching @withlaplace/runtime-${target}@${pkg.version} package, or use Laplace Desktop.`,
			);
		}
		const version = (await readFile(join(directory, "VERSION"), "utf8")).trim();
		if (version !== pkg.version) throw new Error("CLI/runtime package versions do not match.");
		if (installed && compareVersion(installed.version, version) > 0)
			return cliIo.print({
				installed: installed.version,
				reused: true,
				reason: "A newer runtime is already installed.",
			});
		const result = await installRuntime(directory, version);
		const at = argv.indexOf("--profile");
		const profile = runtimeProfile.parse(at < 0 ? "hosted" : argv[at + 1]);
		const update = await swapRunningRuntime({
			root: profileRoot(profile),
			origin: runtimeProfiles[profile].origin,
			nativeHost: true,
		});
		if (!update.swapped && ["restored", "busy", "not-stopped"].includes(update.reason))
			throw new Error(
				`Runtime update did not complete (${update.reason}); inspect status before retrying setup.`,
			);
		cliIo.print({
			installed: result.version,
			update,
			next: "Run laplace start; use laplace enable to start at login.",
		});
		return;
	}
	const informational =
		!argv[0] || argv.includes("--help") || ["help", "--version", "version"].includes(argv[0]);
	if (!installed && !informational)
		throw new Error(
			"Laplace Runtime is not installed. Run laplace setup first, or open Laplace Desktop.",
		);
	// Execute the new CLI against the selected Desktop/headless runtime, not the npm cache.
	if (installed) process.env.LAPLACE_CLI_RUNTIME_DIRECTORY = installed.directory;
	await runCli({ ...cliIo, argv });
}
export function compareVersion(left: string, right: string) {
	const a = left.split(".").map(Number),
		b = right.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
	return 0;
}
void runNpm().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : "Laplace command failed"}\n`);
	process.exitCode = 1;
});
