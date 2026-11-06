import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { computerIdleSeconds } from "@repo/local-mcp-core/update-idle";
import { UpdatePolicyStore, automaticUpdatesEnabled } from "@repo/local-mcp-core/update-policy";

import { userDataRoot } from "./paths";
import type { RuntimeReply } from "./runtime";
import type { HelperMethod } from "./shared/helper-contracts";

type Handle = (method: HelperMethod, input: unknown) => Promise<RuntimeReply>;

/**
 * Automatic managed-connector updates for a runtime with no Desktop attached (Desktop runs its
 * own schedule). Checks start after 15 seconds and repeat every six hours; installation needs
 * 15 minutes of computer inactivity, honors deferral, and waits a minute after wake.
 */
export function scheduleConnectorUpdates(
	handle: Handle,
	desktopConnected: () => boolean,
	options: { interval?: number; idle?: () => Promise<number | undefined> } = {},
) {
	const interval = options.interval ?? 15_000;
	const idle = options.idle ?? computerIdleSeconds;
	let next = Date.now() + 15_000,
		lastTick = Date.now(),
		wakeDeferUntil = 0,
		active: Promise<void> | undefined;
	const tick = () => {
		const now = Date.now();
		if (now - lastTick > interval * 2) wakeDeferUntil = now + 60_000;
		lastTick = now;
		if (active || desktopConnected() || !automaticUpdatesEnabled()) return active;
		active = (async () => {
			const settings = await new UpdatePolicyStore().read();
			if (!settings.connectors) return;
			if (Date.now() >= next) {
				next = Date.now() + 21_600_000;
				await handle("updates.checkConnectors", {});
				await handle("updates.prepareConnectors", {});
			}
			if (Date.now() < wakeDeferUntil || settings.deferredUntil > Date.now()) return;
			const seconds = await idle();
			if (seconds === undefined || seconds < 900) return;
			await handle("updates.automaticConnectors", {});
		})()
			.catch(() => {})
			.finally(() => {
				active = undefined;
			});
		return active;
	};
	const timer = setInterval(() => void tick(), interval);
	timer.unref();
	return { stop: () => clearInterval(timer), tick };
}

export const pointRetentionMs = 7 * 24 * 60 * 60 * 1000;
/** Point captures expire after seven days even while Desktop is closed. */
export async function sweepPointCaptures(
	directory = join(userDataRoot(), "point", "captures"),
	now = Date.now(),
) {
	let removed = 0;
	for (const name of await readdir(directory).catch(() => [] as string[])) {
		if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
		const metadata = join(directory, name);
		try {
			const info = await lstat(metadata);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) continue;
			const createdAt = Number(JSON.parse(await readFile(metadata, "utf8")).createdAt);
			if (!Number.isFinite(createdAt)) continue;
			if (now - createdAt < pointRetentionMs && createdAt <= now) continue;
			await rm(join(directory, name.replace(/\.json$/, ".png")), { force: true });
			await rm(metadata, { force: true });
			removed++;
		} catch {
			/* Desktop may be writing this capture; the next sweep retries. */
		}
	}
	return removed;
}
