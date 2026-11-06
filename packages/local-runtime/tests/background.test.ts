import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const policy = vi.hoisted(() => ({ connectors: true, deferredUntil: 0 }));
vi.mock("@repo/local-mcp-core/update-policy", () => ({
	automaticUpdatesEnabled: () => true,
	UpdatePolicyStore: class {
		async read() {
			return { version: 1, desktop: false, pins: {}, ...policy };
		}
	},
}));

import { pointRetentionMs, scheduleConnectorUpdates, sweepPointCaptures } from "../src/background";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});

it("updates connectors headlessly only when idle, opted in, and without Desktop", async () => {
	const calls: string[] = [];
	const handle = async (method: string) => {
		calls.push(method);
		return { result: true, changed: false };
	};
	let desktop = true,
		idle: number | undefined = 1000;
	vi.useFakeTimers({ now: Date.now() });
	try {
		const scheduler = scheduleConnectorUpdates(handle as never, () => desktop, {
			idle: async () => idle,
		});
		await vi.advanceTimersByTimeAsync(16_000);
		expect(calls).toEqual([]);
		desktop = false;
		await scheduler.tick();
		expect(calls).toEqual([
			"updates.checkConnectors",
			"updates.prepareConnectors",
			"updates.automaticConnectors",
		]);
		calls.length = 0;
		idle = 60;
		await scheduler.tick();
		expect(calls).toEqual([]);
		idle = undefined;
		await scheduler.tick();
		expect(calls).toEqual([]);
		policy.connectors = false;
		idle = 1000;
		await scheduler.tick();
		expect(calls).toEqual([]);
		scheduler.stop();
	} finally {
		policy.connectors = true;
		vi.useRealTimers();
	}
});

it("removes only expired Point captures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "point-retention-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const now = Date.now();
	const fresh = "11111111-1111-4111-8111-111111111111",
		expired = "22222222-2222-4222-8222-222222222222";
	for (const [id, createdAt] of [
		[fresh, now - 1000],
		[expired, now - pointRetentionMs - 1],
	] as const) {
		await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, createdAt }));
		await writeFile(join(directory, `${id}.png`), "png");
	}
	expect(await sweepPointCaptures(directory, now)).toBe(1);
	expect((await readdir(directory)).sort()).toEqual([`${fresh}.json`, `${fresh}.png`]);
});
