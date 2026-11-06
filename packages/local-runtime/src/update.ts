import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { controlRequest, readRuntimeDescriptor } from "./control";
import { currentRuntime, selectRuntime } from "./install";
import { explicitlyStopped, startRuntime } from "./lifecycle";
import { runtimeHome } from "./paths";

export type SwapOptions = {
	root: string;
	origin: string;
	nativeHost?: boolean;
	home?: string;
	/** How long to wait for local work to finish before deferring the swap. */
	drainTimeout?: number;
	pollInterval?: number;
};
export type SwapResult =
	| { swapped: false; reason: "not-running" | "current" | "stopped" | "busy" }
	| { swapped: true; from?: string; to: string }
	| { swapped: false; reason: "restored"; from?: string; to: string; error: string };

async function waitForExit(pid: number, timeout: number) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await delay(200);
	}
	return false;
}

/**
 * Moves a running runtime onto the selected installed version. Work drains first under the
 * shared maintenance lease (new calls are refused as not started), the old process stops, the
 * new version must pass a health check, and any failure restores the previous version.
 * Interrupted calls are never replayed.
 */
export async function swapRunningRuntime(options: SwapOptions): Promise<SwapResult> {
	const home = options.home ?? runtimeHome();
	const target = await currentRuntime(home);
	if (!target) throw new Error("No installed Laplace Runtime is selected");
	const running = await readRuntimeDescriptor(options.root);
	if (!running) return { swapped: false, reason: "not-running" };
	const info = await controlRequest<{ version?: string }>(
		running,
		"runtime.info",
		{},
		10_000,
	).catch(() => ({ version: undefined }));
	if (info.version === target.version) return { swapped: false, reason: "current" };
	// Runtimes from before runtime.info are identified by the installer's previous selection.
	const previousVersion =
		info.version ??
		((await readFile(join(home, "previous"), "utf8").catch(() => "")).trim() || undefined);
	const deadline = Date.now() + (options.drainTimeout ?? 600_000);
	let acquired = false;
	while (!acquired && Date.now() < deadline) {
		acquired = await controlRequest<boolean>(running, "updates.acquire", {}, 30_000).catch(
			() => false,
		);
		if (!acquired) await delay(options.pollInterval ?? 5000);
	}
	if (!acquired) return { swapped: false, reason: "busy" };
	await controlRequest(running, "shutdown", {}, 10_000).catch(() => {});
	if (!(await waitForExit(running.pid, 20_000))) process.kill(running.pid, "SIGTERM");
	await waitForExit(running.pid, 5000);
	if (await explicitlyStopped(options.root)) return { swapped: false, reason: "stopped" };
	const launch = (layout: { node: string; service: string; directory: string }) =>
		startRuntime({
			root: options.root,
			node: layout.node,
			service: layout.service,
			resources: layout.directory,
			origin: options.origin,
			nativeHost: options.nativeHost,
			explicit: true,
		});
	try {
		const started = await launch(target);
		const health = await controlRequest<{ version?: string }>(started, "runtime.info", {}, 15_000);
		if (health.version !== target.version)
			throw new Error("Updated runtime reported another version");
		await controlRequest(started, "status", {}, 15_000);
		return { swapped: true, from: info.version, to: target.version };
	} catch (error) {
		// Restore the previous selection and process; nothing interrupted is replayed.
		const descriptor = await readRuntimeDescriptor(options.root);
		if (descriptor) {
			await controlRequest(descriptor, "shutdown", {}, 10_000).catch(() => {});
			await waitForExit(descriptor.pid, 20_000);
		}
		if (previousVersion) {
			await selectRuntime(previousVersion, home);
			const previous = await currentRuntime(home);
			if (previous) await launch(previous).catch(() => {});
		}
		return {
			swapped: false,
			reason: "restored",
			from: previousVersion,
			to: target.version,
			error: error instanceof Error ? error.message : "Runtime update failed",
		};
	}
}
