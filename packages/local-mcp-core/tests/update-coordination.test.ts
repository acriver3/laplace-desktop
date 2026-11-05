import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { UpdateCoordination } from "../src/update-coordination";
it("pauses peer transports and reloads them after the update", async () => {
	const root = await mkdtemp(join(tmpdir(), "update-coordination-"));
	const resumed = vi.fn(async () => {}),
		pause = vi.fn(() => vi.fn());
	const owner = new UpdateCoordination(
		root,
		() => false,
		pause,
		async () => {},
	);
	const peer = new UpdateCoordination(root, () => false, pause, resumed);
	try {
		await owner.start();
		await peer.start();
		const release = await owner.acquire(() => vi.fn());
		expect(release).toBeTypeOf("function");
		expect(peer.blocked).toBe(true);
		release!();
		await vi.waitFor(() => expect(resumed).toHaveBeenCalledOnce());
		expect(peer.blocked).toBe(false);
	} finally {
		await owner.stop();
		await peer.stop();
		await rm(root, { recursive: true, force: true });
	}
});
it("manual updaters can acquire before starting a scheduler", async () => {
	const root = await mkdtemp(join(tmpdir(), "update-manual-"));
	const owner = new UpdateCoordination(
		root,
		() => false,
		() => () => {},
		async () => {},
	);
	try {
		const release = await owner.acquire(() => () => {});
		expect(release).toBeTypeOf("function");
		release!();
	} finally {
		await owner.stop();
		await rm(root, { recursive: true, force: true });
	}
});
it("does not acquire while another owner has active work", async () => {
	const root = await mkdtemp(join(tmpdir(), "update-busy-owner-"));
	const owner = new UpdateCoordination(
		root,
		() => false,
		() => () => {},
		async () => {},
	);
	const pause = vi.fn(() => () => {});
	const peer = new UpdateCoordination(
		root,
		() => true,
		pause,
		async () => {},
	);
	try {
		await owner.start();
		await peer.start();
		expect(await owner.acquire(() => () => {})).toBeUndefined();
		expect(pause).not.toHaveBeenCalled();
	} finally {
		await owner.stop();
		await peer.stop();
		await rm(root, { recursive: true, force: true });
	}
});
