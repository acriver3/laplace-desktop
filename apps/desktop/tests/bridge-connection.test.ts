import { closeMcpConnection } from "@repo/local-mcp-core/mcp-lifecycle";
import { BridgeConnection } from "@repo/local-runtime/bridge-connection";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
function link() {
	let disconnect!: () => void;
	return {
		client: { write: vi.fn() },
		close: vi.fn(async () => {}),
		closed: new Promise<void>((resolve) => {
			disconnect = resolve;
		}),
		disconnect: () => disconnect(),
	};
}
it("shares discovery, reconnects notifications after loss, and never replays a write", async () => {
	vi.useFakeTimers();
	const first = link(),
		second = link();
	first.client.write.mockRejectedValue(new Error("response lost"));
	const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
	const bridge = new BridgeConnection<ReturnType<typeof link>["client"]>(connect);
	expect(await Promise.all([bridge.ready(), bridge.ready()])).toEqual([first.client, first.client]);
	await expect((await bridge.ready()).write()).rejects.toThrow("response lost");
	first.disconnect();
	await vi.advanceTimersByTimeAsync(300);
	expect(await bridge.ready()).toBe(second.client);
	expect(connect).toHaveBeenCalledTimes(2);
	expect(first.client.write).toHaveBeenCalledTimes(1);
	expect(second.client.write).not.toHaveBeenCalled();
	await bridge.close();
	expect(first.close).toHaveBeenCalledTimes(1);
	expect(second.close).toHaveBeenCalledTimes(1);
});
it("recovers rejected discovery promises and stops reconnecting on close", async () => {
	vi.useFakeTimers();
	const ready = link();
	const connect = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(ready);
	const bridge = new BridgeConnection(connect);
	await expect(bridge.ready()).rejects.toThrow("offline");
	await vi.advanceTimersByTimeAsync(250);
	expect(await bridge.ready()).toBe(ready.client);
	await bridge.close();
	ready.disconnect();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(connect).toHaveBeenCalledTimes(2);
	await expect(bridge.ready()).rejects.toThrow("closed");
});
it("bounds failed legacy DELETE cleanup and closes the transport, while modern cleanup skips DELETE", async () => {
	vi.useFakeTimers();
	const client = { close: vi.fn(async () => {}) };
	const transport = {
		sessionId: "legacy",
		terminateSession: vi.fn(() => new Promise<void>(() => {})),
		close: vi.fn(async () => {}),
	};
	const closing = closeMcpConnection(client, transport);
	await vi.advanceTimersByTimeAsync(1000);
	await closing;
	expect(client.close).toHaveBeenCalledTimes(1);
	expect(transport.close).toHaveBeenCalledTimes(1);
	await closeMcpConnection(client, { ...transport, sessionId: undefined });
	expect(transport.terminateSession).toHaveBeenCalledTimes(1);
});
