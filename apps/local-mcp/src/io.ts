import { spawn } from "node:child_process";
import type { CliIo } from "./cli";

export const cliIo: Omit<CliIo, "argv"> = {
	print(value) {
		if (value !== undefined)
			process.stdout.write(
				typeof value === "string" ? value + "\n" : JSON.stringify(value, null, 2) + "\n",
			);
	},
	async confirm(message) {
		if (!process.stdin.isTTY)
			throw new Error(
				"Explicit local confirmation required. Run in a terminal, or pass --confirm after reviewing.",
			);
		const { createInterface } = await import("node:readline/promises");
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		try {
			return (await rl.question(message + " [y/N] ")).trim().toLowerCase() === "y";
		} finally {
			rl.close();
		}
	},
	openUrl(url) {
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
	},
};
