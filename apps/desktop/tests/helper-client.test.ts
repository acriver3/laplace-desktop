import { EventEmitter } from "node:events";

import { afterEach, expect, it, vi } from "vitest";

import { HelperClient } from "../src/main/helper-client";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

class Child extends EventEmitter {
	connected = true;
	exitCode: number | null = null;
	signalCode: string | null = null;
	stderr = { resume: vi.fn() };
	send = vi.fn((_message: unknown, callback?: (error?: Error) => void) => callback?.());
	kill = vi.fn();
}
const children: Child[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.emit("exit", 0);
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});
function fixture() {
	const child = new Child();
	children.push(child);
	mocks.spawn.mockReturnValue(child);
	const changed = vi.fn(),
		failed = vi.fn();
	const helper = new HelperClient(changed, failed);
	const started = helper.start(
		"/temporary/profile",
		"/temporary/resources",
		"http://127.0.0.1:3004",
		"/temporary/helper.cjs",
	);
	return { child, helper, started, changed, failed };
}

it("passes the browser adapter opt-in to the helper without forwarding arbitrary environment values", async () => {
	vi.stubEnv("LAPLACE_BROWSER_CONNECTION_ENABLED", "true");
	vi.stubEnv("LAPLACE_UNRELATED_TEST_SECRET", "not-for-the-helper");
	const f = fixture();
	f.child.emit("message", { event: "ready" });
	await f.started;
	const options = mocks.spawn.mock.calls[0]![2];
	expect(options.env.LAPLACE_BROWSER_CONNECTION_ENABLED).toBe("true");
	expect(options.env.LAPLACE_UNRELATED_TEST_SECRET).toBeUndefined();
});

it("rejects early requests until the helper has installed its IPC listener and declared readiness", async () => {
	const f = fixture();
	await expect(f.helper.request("status")).rejects.toThrow("still starting");
	expect(f.child.send).not.toHaveBeenCalled();
	f.child.emit("message", { event: "ready" });
	await f.started;
	const requested = f.helper.request("status");
	const message = f.child.send.mock.calls[0]![0] as { id: string; method: string };
	expect(message.method).toBe("status");
	f.child.emit("message", { id: message.id, result: { mode: "local-only" } });
	await expect(requested).resolves.toEqual({ mode: "local-only" });
});

it("rejects pending work after helper failure without replaying it", async () => {
	const f = fixture();
	f.child.emit("message", { event: "ready" });
	await f.started;
	const requested = expect(f.helper.request("server.start", { id: "fixture" })).rejects.toThrow(
		"not replayed",
	);
	f.child.emit("exit", 1);
	await requested;
	await expect(f.helper.request("status")).rejects.toThrow("unavailable");
	expect(mocks.spawn).toHaveBeenCalledTimes(1);
	expect(f.child.send).toHaveBeenCalledTimes(1);
	expect(f.failed).toHaveBeenCalledOnce();
});

it("waits for actual helper exit after shutdown acknowledgement", async () => {
	const f = fixture();
	f.child.emit("message", { event: "ready" });
	await f.started;
	let stopped = false;
	const stopping = f.helper.stop().then(() => {
		stopped = true;
	});
	const message = f.child.send.mock.calls[0]![0] as { id: string; method: string };
	expect(message.method).toBe("shutdown");
	f.child.emit("message", { id: message.id, result: { stopping: true } });
	await new Promise((resolve) => setImmediate(resolve));
	expect(stopped).toBe(false);
	f.child.emit("exit", 0);
	await stopping;
	expect(stopped).toBe(true);
	expect(f.failed).not.toHaveBeenCalled();
	expect(f.child.kill).not.toHaveBeenCalled();
});


it("withholds startup snapshots until catalog reads can succeed", async () => {
	const f = fixture();
	const snapshot = { endpoint: "http://127.0.0.1:1234", mode: "local-only" };
	f.child.emit("message", { event: "snapshot", data: snapshot });
	expect(f.changed).not.toHaveBeenCalled();
	let request: Promise<unknown> | undefined;
	f.changed.mockImplementation((event) => {
		if (event.event === "snapshot") request = f.helper.request("catalog.list");
	});
	f.child.emit("message", { event: "ready" });
	await f.started;
	expect(f.changed).toHaveBeenCalledWith({ event: "snapshot", data: snapshot });
	const message = f.child.send.mock.calls[0]![0] as { id: string; method: string };
	expect(message.method).toBe("catalog.list");
	f.child.emit("message", { id: message.id, result: [{ id: "fixture" }] });
	await expect(request).resolves.toEqual([{ id: "fixture" }]);
});
