import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
	LOCAL_RUNTIME_PROTOCOL,
	localRuntimeDescriptorFile,
	type LocalRuntimeDescriptor,
} from "@repo/project-protocol/local-runtime";

import { helperRequest, type HelperEvent } from "./shared/helper-contracts";
import { createRuntime, type Runtime } from "./runtime";
import type { ControlServer } from "./server";

function option(argv: string[], name: string) {
	const index = argv.indexOf(name);
	const value = index < 0 ? undefined : argv[index + 1];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

/** Headless fallback for runtime prompts that would otherwise wait for a Desktop window. */
function openBrowser(url: string) {
	const parsed = new URL(url);
	const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return;
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

/** Background host: the runtime outlives Desktop windows and AI-client bridges. */
export async function startService(argv = process.argv) {
	const root = resolve(option(argv, "--root"));
	const listeners = new Set<(event: HelperEvent) => void>();
	const emit = (event: HelperEvent) => {
		if (!listeners.size && event.event === "open-url") openBrowser(event.url);
		for (const listener of listeners) listener(event);
	};
	let runtime: Runtime | undefined;
	let stopping: Promise<void> | undefined;
	const control: ControlServer = {
		token: randomBytes(32).toString("base64url"),
		protocol: LOCAL_RUNTIME_PROTOCOL,
		async request(method, input) {
			const known = helperRequest.shape.method.safeParse(method);
			if (!known.success) return { error: "Unsupported runtime operation" };
			if (!runtime) return { error: "Laplace Runtime is starting" };
			const { changed, shutdown, ...reply } = await runtime.handle(known.data, input);
			// Reply first; closing the server drops open connections.
			if (shutdown) setTimeout(() => void stop(), 100);
			else if (changed) emit({ event: "snapshot", data: runtime.snapshot() });
			return reply;
		},
		subscribe(listener) {
			listeners.add(listener);
			if (runtime) listener({ event: "snapshot", data: runtime.snapshot() });
			return () => listeners.delete(listener);
		},
	};
	runtime = await createRuntime({
		root,
		resources: option(argv, "--resources"),
		origin: option(argv, "--origin"),
		bridgePath: join(dirname(argv[1]!), "bridge.cjs"),
		emit,
		control,
	});
	const descriptor = join(root, localRuntimeDescriptorFile);
	const stop = () =>
		(stopping ??= (async () => {
			await rm(descriptor, { force: true });
			await runtime!.stop();
			process.exit(0);
		})());
	process.once("SIGTERM", () => void stop());
	process.once("SIGINT", () => void stop());
	process.once("SIGHUP", () => void stop());
	const value: LocalRuntimeDescriptor = {
		version: 1,
		protocol: LOCAL_RUNTIME_PROTOCOL,
		pid: process.pid,
		control: runtime.server.endpoint.replace(/\/mcp$/, "/control/v1/"),
		token: control.token,
	};
	const temporary = `${descriptor}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
	await rename(temporary, descriptor);
	emit({ event: "ready" });
	void runtime.hosted.restore().catch(() => {});
	return { runtime, stop };
}

if (process.argv[1]?.endsWith("service.cjs") || process.argv[1]?.endsWith("service.ts"))
	void startService().catch(() => {
		process.stderr.write(
			"Laplace Runtime initialization failed. Check its keychain, runtime, and profile lock.\n",
		);
		process.exit(1);
	});
