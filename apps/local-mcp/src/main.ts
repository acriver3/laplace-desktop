import { spawn } from "node:child_process";

import { runCli } from "./cli";

function openUrl(url: string) {
	const parsed = new URL(url);
	if (!["https:", "http:"].includes(parsed.protocol)) return;
	const [command, args] =
		process.platform === "darwin"
			? ["open", [parsed.href]]
			: process.platform === "win32"
				? ["rundll32.exe", ["url.dll,FileProtocolHandler", parsed.href]]
				: ["xdg-open", [parsed.href]];
	const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", () => {});
	child.unref();
}

// stdout carries only results (and MCP frames for `serve`); diagnostics go to stderr.
void runCli({
	argv: process.argv.slice(2),
	print: (value) => {
		if (value !== undefined)
			process.stdout.write(
				typeof value === "string" ? value + "\n" : JSON.stringify(value, null, 2) + "\n",
			);
	},
	confirm: async (message) => {
		const { createInterface } = await import("node:readline/promises");
		if (!process.stdin.isTTY)
			throw new Error(
				"Explicit local confirmation required. Run in a terminal, or pass --confirm after reviewing.",
			);
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		try {
			return (await rl.question(message + " [y/N] ")).trim().toLowerCase() === "y";
		} finally {
			rl.close();
		}
	},
	openUrl,
}).catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : "Laplace command failed"}\n`);
	process.exitCode = 1;
});
