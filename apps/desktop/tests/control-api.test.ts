import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EntryFactory } from "@repo/local-mcp-core/store";
import { LOCAL_RUNTIME_PROTOCOL } from "@repo/project-protocol/local-runtime";
import { afterEach, expect, it } from "vitest";

import { DesktopManager } from "../src/helper/manager";
import { startMcpServer, type ControlServer } from "../src/helper/server";
import { RuntimeClient } from "../src/main/runtime-client";
import type { HelperEvent } from "../src/shared/helper-contracts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});

async function fixture(withControl = true) {
	const root = await mkdtemp(join(tmpdir(), "desktop-control-test-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const secrets = new Map<string, string>();
	const entries: EntryFactory = async (name) => ({
		getPassword: () => secrets.get(name) ?? null,
		setPassword: (value) => void secrets.set(name, value),
		deletePassword: () => void secrets.delete(name),
	});
	const manager = new DesktopManager(
		root,
		join(root, "resources"),
		"https://connect.fixture.invalid",
		{ entries },
	);
	cleanup.push(() => manager.shutdown());
	await manager.initialize();
	const listeners = new Set<(event: unknown) => void>();
	const requests: Array<{ method: string; input: unknown }> = [];
	const control: ControlServer = {
		token: "control-token-".padEnd(43, "x"),
		protocol: LOCAL_RUNTIME_PROTOCOL,
		async request(method, input) {
			requests.push({ method, input });
			return method === "status" ? { result: { ok: true } } : { error: "Unsupported" };
		},
		subscribe(listener) {
			listeners.add(listener);
			listener({ event: "ready" });
			return () => listeners.delete(listener);
		},
	};
	const server = await startMcpServer(
		manager,
		{ tools: () => [], call: async () => ({}) as never },
		undefined,
		undefined,
		undefined,
		withControl ? control : undefined,
	);
	cleanup.push(() => server.close());
	const base = server.endpoint.replace(/\/mcp$/, "/control/v1/");
	const emit = (event: unknown) => {
		for (const listener of listeners) listener(event);
	};
	return { root, manager, server, control, base, requests, emit, secrets };
}

const headers = (token: string, protocol = LOCAL_RUNTIME_PROTOCOL) => ({
	Authorization: `Bearer ${token}`,
	"Laplace-Runtime-Protocol": String(protocol),
	"Content-Type": "application/json",
});

it("requires the management token, not an AI-client token", async () => {
	const { manager, server, control, base, requests, secrets } = await fixture();
	const post = (init: RequestInit) =>
		fetch(new URL("request", base), {
			method: "POST",
			body: JSON.stringify({ method: "status" }),
			...init,
		});
	expect((await post({})).status).toBe(401);
	expect((await post({ headers: headers("wrong") })).status).toBe(401);
	const client = await manager.registerClient("Fixture assistant");
	const clientToken = secrets.get(`client:${client.id}`)!;
	expect(manager.authenticateClient(clientToken)?.id).toBe(client.id);
	expect((await post({ headers: headers(clientToken) })).status).toBe(401);
	expect(requests).toHaveLength(0);

	const ok = await post({ headers: headers(control.token) });
	expect(ok.status).toBe(200);
	expect(await ok.json()).toEqual({ result: { ok: true } });
	expect(requests).toEqual([{ method: "status", input: {} }]);

	// The management credential never authorizes connector execution.
	const mcp = await fetch(server.endpoint, {
		method: "POST",
		headers: { ...headers(control.token), Accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
	expect(mcp.status).toBe(401);
});

it("rejects browser origins and mismatched protocol generations", async () => {
	const { control, base } = await fixture();
	const origin = await fetch(new URL("request", base), {
		method: "POST",
		headers: { ...headers(control.token), Origin: "https://connect.withlaplace.com" },
		body: JSON.stringify({ method: "status" }),
	});
	expect(origin.status).toBe(403);
	const stale = await fetch(new URL("request", base), {
		method: "POST",
		headers: headers(control.token, LOCAL_RUNTIME_PROTOCOL + 1),
		body: JSON.stringify({ method: "status" }),
	});
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ error: "protocol", protocol: LOCAL_RUNTIME_PROTOCOL });
});

it("is not served unless the runtime host enables it", async () => {
	const { base } = await fixture(false);
	const response = await fetch(new URL("request", base), {
		method: "POST",
		headers: headers("control-token-".padEnd(43, "x")),
		body: JSON.stringify({ method: "status" }),
	});
	expect(response.status).toBe(403);
});

it("connects Desktop through the runtime descriptor and streams events", async () => {
	const { root, control, base, emit } = await fixture();
	await writeFile(
		join(root, "runtime.json"),
		JSON.stringify({
			version: 1,
			protocol: LOCAL_RUNTIME_PROTOCOL,
			pid: process.pid,
			control: base,
			token: control.token,
		}),
		{ mode: 0o600 },
	);
	const events: HelperEvent[] = [];
	const failures: string[] = [];
	const client = new RuntimeClient(
		(event) => events.push(event),
		(message) => failures.push(message),
	);
	await client.start(root, join(root, "resources"), "https://connect.fixture.invalid", "unused");
	cleanup.push(() => client.stop());
	expect(await client.request("status")).toEqual({ ok: true });
	await expect(client.request("link.unlink")).rejects.toThrow("Unsupported");
	emit({ event: "open-url", url: "https://connect.fixture.invalid/authorize" });
	await expect.poll(() => events.map((event) => event.event)).toContain("open-url");
	await client.stop();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(failures).toEqual([]);
});
