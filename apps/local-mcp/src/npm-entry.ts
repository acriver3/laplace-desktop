#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { currentRuntime, installRuntime } from "@repo/local-runtime/install";
import { runtimeProfile, profileRoot, runtimeProfiles } from "@repo/local-runtime/paths";
import { swapRunningRuntime } from "@repo/local-runtime/update";
import { runCli, type CliIo } from "./cli";
import { cliIo } from "./io";
import { WaitTimeout } from "./management";
import pkg from "../../desktop/package.json";

async function runNpm(argv: string[], io: Omit<CliIo, "argv">) {
	if (!argv[0] || argv[0] === "help" || argv.includes("--help")) {
		await runCli({
			...io,
			argv,
			print: (usage) =>
				io.print(
					`${usage}\nlaplace setup installs the packaged runtime. Append --jsonl for machine-readable output.\n` +
						"CLI automation guide: https://withlaplace.com/docs#laplace-cli-automation",
				),
		});
		return;
	}
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
			return io.print({
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
		io.print({
			installed: result.version,
			update,
			next: "Run laplace start; use laplace enable to start at login.",
		});
		return;
	}
	const informational = ["--version", "version"].includes(argv[0]);
	if (!installed && !informational)
		throw new Error(
			"Laplace Runtime is not installed. Run laplace setup first, or open Laplace Desktop.",
		);
	// Execute the new CLI against the selected Desktop/headless runtime, not the npm cache.
	if (installed) process.env.LAPLACE_CLI_RUNTIME_DIRECTORY = installed.directory;
	await runCli({ ...io, argv });
}
export function compareVersion(left: string, right: string) {
	const a = left.split(".").map(Number),
		b = right.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
	return 0;
}
const args = process.argv.slice(2);
const jsonl = args.includes("--jsonl");
const argv = args.filter((arg) => arg !== "--jsonl");
const mcpStdio = argv[0] === "serve" || argv[0] === "bridge";
const writeJsonLine = (record: object) => process.stdout.write(JSON.stringify(record) + "\n");
const io = jsonl
	? {
			...cliIo,
			print: (data: unknown) => {
				if (data !== undefined) writeJsonLine({ type: "result", data });
			},
		}
	: cliIo;

async function main() {
	if (jsonl && mcpStdio) throw new Error("--jsonl is unavailable for MCP stdio commands");
	await runNpm(argv, io);
}

void main().catch((error) => {
	const message = error instanceof Error ? error.message : "Laplace command failed";
	if (jsonl && !mcpStdio) {
		if (error instanceof WaitTimeout) io.print(error.receipt);
		writeJsonLine({
			type: "error",
			code: error instanceof WaitTimeout ? "timeout" : "command_failed",
			message,
		});
	}
	process.stderr.write(message + "\n");
	process.exitCode = 1;
});
