import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import type { ServerConfig } from "@repo/local-mcp-core/config";

type ProcessInfo = { pid: number; command: string };
const execute = promisify(execFile);

// Process command lines stay in the helper and are never returned in diagnostics.
async function processes(): Promise<ProcessInfo[]> {
	if (process.platform === "win32") {
		const { stdout } = await execute(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
			],
			{ timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
		);
		const rows = JSON.parse(stdout);
		return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
			pid: Number(row.ProcessId),
			command: String(row.CommandLine ?? ""),
		}));
	}
	const { stdout } = await execute("/bin/ps", ["-axo", "pid=,command="], {
		timeout: 10_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout.split("\n").flatMap((line) => {
		const match = line.match(/^\s*(\d+)\s+(.*)$/);
		return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
	});
}

/** Older wrappers do not know the shared lease format; migration checks their processes too. */
export async function assertLegacyProcessesStopped(config: ServerConfig, inspect = processes) {
	if (config.transport !== "stdio") return;
	let running: ProcessInfo[];
	try {
		running = await inspect();
	} catch {
		throw new Error(
			"Cannot inspect old connector processes. Stop the old Laplace wrapper and retry migration activation.",
		);
	}
	const markers = config.args.filter((arg) => isAbsolute(arg) && !arg.startsWith("--"));
	const normalize = (text: string) =>
		process.platform === "win32" ? text.toLowerCase().replaceAll("\\", "/") : text;
	const conflict = running.some(
		({ pid, command }) =>
			pid !== process.pid &&
			(/(?:^|[\s/\\])laplace-local(?:[\s/\\]|$)/i.test(command) ||
				/[/\\]local-mcp[/\\].*[/\\]cli\.cjs(?:\s|$)/i.test(command) ||
				markers.some((marker) => normalize(command).includes(normalize(marker)))),
	);
	if (conflict)
		throw new Error(
			"An old Laplace wrapper or matching connector is still running. Stop it in your AI clients before activating this migrated connector.",
		);
}
