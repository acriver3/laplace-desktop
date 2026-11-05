import { describe, expect, it, vi } from "vitest";

import { InvocationQueue } from "../../../packages/local-mcp-core/src/invocation-queue";
import { AutomaticUpdates, type AutomaticUpdateHost } from "../src/update/automatic";

function fixture() {
	let now = 0;
	const release = vi.fn();
	const host: AutomaticUpdateHost = {
		check: vi.fn(async () => {}),
		prepare: vi.fn(async () => {}),
		ready: vi.fn(() => true),
		idleSeconds: vi.fn(() => 900),
		busy: vi.fn(() => false),
		acquireMaintenance: vi.fn(() => release),
		apply: vi.fn(async () => {}),
		countdown: vi.fn(),
		error: vi.fn(),
	};
	let flag = true;
	const updates = new AutomaticUpdates(
		host,
		() => flag,
		() => now,
	);
	return {
		host,
		updates,
		release,
		time: (value: number) => {
			now = value;
		},
		flag: (value: boolean) => {
			flag = value;
		},
	};
}

describe("automatic update scheduling", () => {
	it("requires both explicit opt-in and the execution feature flag", async () => {
		const f = fixture();
		await f.updates.tick();
		expect(f.host.countdown).not.toHaveBeenCalled();
		f.updates.setEnabled(true);
		f.flag(false);
		await f.updates.tick();
		expect(f.host.countdown).not.toHaveBeenCalled();
	});
	it("applies only after a full countdown and releases maintenance", async () => {
		const f = fixture();
		f.updates.setEnabled(true);
		await f.updates.tick();
		f.time(59_999);
		await f.updates.tick();
		expect(f.host.apply).not.toHaveBeenCalled();
		f.time(60_000);
		await f.updates.tick();
		expect(f.host.apply).toHaveBeenCalledOnce();
		expect(f.release).toHaveBeenCalledOnce();
	});
	it.each([undefined, 899, Number.NaN])("defers when system idle time is %s", async (idle) => {
		const f = fixture();
		f.updates.setEnabled(true);
		vi.mocked(f.host.idleSeconds).mockReturnValue(idle);
		await f.updates.tick();
		f.time(60_000);
		await f.updates.tick();
		expect(f.host.apply).not.toHaveBeenCalled();
	});
	it("cancels countdown on local activity and starts a fresh countdown", async () => {
		const f = fixture();
		f.updates.setEnabled(true);
		await f.updates.tick();
		vi.mocked(f.host.busy).mockReturnValue(true);
		f.time(60_000);
		await f.updates.tick();
		expect(f.host.countdown).toHaveBeenLastCalledWith(undefined);
		vi.mocked(f.host.busy).mockReturnValue(false);
		await f.updates.tick();
		expect(f.host.apply).not.toHaveBeenCalled();
		expect(f.host.countdown).toHaveBeenLastCalledWith(120_000);
	});
	it("disabling during a check prevents preparation even if immediately reenabled", async () => {
		const f = fixture();
		vi.mocked(f.host.ready).mockReturnValue(false);
		let done!: () => void;
		vi.mocked(f.host.check).mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					done = resolve;
				}),
		);
		f.updates.setEnabled(true);
		f.time(15_000);
		const pending = f.updates.tick();
		f.updates.setEnabled(false);
		f.updates.setEnabled(true);
		done();
		await pending;
		expect(f.host.prepare).not.toHaveBeenCalled();
	});
	it("postpones for 24 hours and cannot apply without maintenance ownership", async () => {
		const f = fixture();
		f.updates.setEnabled(true);
		f.updates.postpone();
		f.time(86_399_999);
		await f.updates.tick();
		expect(f.host.countdown).not.toHaveBeenCalled();
		f.time(86_400_000);
		await f.updates.tick();
		vi.mocked(f.host.acquireMaintenance).mockReturnValue(undefined);
		f.time(86_460_000);
		await f.updates.tick();
		expect(f.host.apply).not.toHaveBeenCalled();
	});
});

it("requires a fresh restart notice after sleep and resume", async () => {
	const f = fixture();
	f.updates.setEnabled(true);
	await f.updates.tick();
	f.time(50000);
	f.updates.resume();
	expect(f.host.countdown).toHaveBeenLastCalledWith(undefined);
	f.time(60000);
	await f.updates.tick();
	expect(f.host.apply).not.toHaveBeenCalled();
	f.time(110000);
	await f.updates.tick();
	expect(f.host.countdown).toHaveBeenLastCalledWith(170000);
});

describe("atomic connector maintenance", () => {
	it("rejects calls during maintenance without executing them", async () => {
		const queue = new InvocationQueue();
		const release = queue.tryMaintenance()!;
		const work = vi.fn();
		await expect(queue.add(work, new AbortController().signal)).rejects.toThrow("not started");
		expect(work).not.toHaveBeenCalled();
		release();
		release();
		await queue.add(work, new AbortController().signal);
		expect(work).toHaveBeenCalledOnce();
	});
	it("refuses maintenance while calls are active or queued", async () => {
		const queue = new InvocationQueue();
		let done!: () => void;
		const first = queue.add(
			() =>
				new Promise<void>((resolve) => {
					done = resolve;
				}),
			new AbortController().signal,
		);
		await Promise.resolve();
		const second = queue.add(async () => {}, new AbortController().signal);
		expect(queue.activity).toEqual({ active: 1, queued: 1 });
		expect(queue.tryMaintenance()).toBeUndefined();
		done();
		await Promise.all([first, second]);
	});
});

it("keeps checking every six hours while an update is prepared", async () => {
	const f = fixture();
	f.updates.setEnabled(true);
	f.updates.postpone();
	f.time(15_000);
	await f.updates.tick();
	expect(f.host.check).toHaveBeenCalledTimes(1);
	f.time(15_000 + 6 * 60 * 60 * 1000);
	await f.updates.tick();
	expect(f.host.check).toHaveBeenCalledTimes(2);
});
it("does not shorten a user postponement on resume", async () => {
	const f = fixture();
	f.updates.setEnabled(true);
	f.updates.postpone();
	f.time(1000);
	f.updates.resume();
	f.time(120_000);
	await f.updates.tick();
	expect(f.host.countdown).not.toHaveBeenCalled();
});
