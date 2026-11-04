import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

// Only the nonsecret registration is stored here. Desktop's bridge retrieves
// the per-client credential from the OS keychain and discovers the current port.
export function validateRegistration(value) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !["command", "args", "type"].includes(key)) ||
		(value.type !== undefined && value.type !== "stdio") ||
		typeof value.command !== "string" ||
		!isAbsolute(value.command) ||
		!Array.isArray(value.args) ||
		value.args.length !== 5 ||
		!value.args.every((arg) => typeof arg === "string") ||
		!isAbsolute(value.args[0]) ||
		value.args[1] !== "--root" ||
		!isAbsolute(value.args[2]) ||
		value.args[3] !== "--client-id" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.args[4])
	) {
		throw new Error(
			"Expected the command and args from a Laplace Desktop AI client bridge registration.",
		);
	}
	return { command: value.command, args: value.args };
}

async function main() {
	const file =
		process.env.LAPLACE_PLUGIN_BRIDGE_CONFIG ||
		join(homedir(), ".laplace-desktop", "plugin-bridge.json");
	if (!isAbsolute(file)) throw new Error("LAPLACE_PLUGIN_BRIDGE_CONFIG must be an absolute path.");
	if (process.argv[2] === "--configure" && process.argv.length === 4) {
		const entry = validateRegistration(JSON.parse(await readFile(process.argv[3], "utf8")));
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
		process.stderr.write("Laplace local bridge configured. Reload the plugin's MCP connections.\n");
		return;
	}
	if (process.argv.length !== 2)
		throw new Error("Usage: local-bridge.mjs [--configure registration.json]");
	let entry;
	try {
		entry = validateRegistration(JSON.parse(await readFile(file, "utf8")));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		throw new Error(
			"Set up the local connection in Laplace Desktop → On this device → AI clients. Follow the Laplace plugin README to save its bridge registration; no Laplace login is required.",
		);
	}
	const child = spawn(entry.command, entry.args, {
		stdio: ["pipe", "inherit", "inherit"],
		shell: false,
		windowsHide: true,
	});
	child.on("error", () => {
		process.stderr.write(
			"Cannot launch the Laplace Desktop bridge. Check the saved registration and Desktop installation.\n",
		);
		process.exitCode = 1;
	});
	let stopping = false;
	let shutdownTimer;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		process.stdin.unpipe(child.stdin);
		child.stdin.end();
		shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
	};
	child.stdin.on("error", stop);
	process.stdin.pipe(child.stdin);
	process.stdin.once("end", stop);
	for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
	child.on("exit", (code, signal) => {
		clearTimeout(shutdownTimer);
		process.stdin.unpipe(child.stdin);
		process.stdin.pause();
		process.exitCode = code ?? 1;
		if (signal) {
			process.removeAllListeners(signal);
			process.kill(process.pid, signal);
		}
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}
