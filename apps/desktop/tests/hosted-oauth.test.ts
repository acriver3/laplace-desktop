import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { EntryFactory } from "@repo/local-mcp-core/store";
import { afterEach, expect, it, vi } from "vitest";

import { HostedConnections } from "../src/helper/hosted-oauth";
import { DesktopManager } from "../src/helper/manager";
import { startMcpServer } from "../src/helper/server";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
	vi.restoreAllMocks();
});
async function fixture(cacheTtlMs = 0) {
	let origin = "",
		next = 0,
		writes = 0;
	const registrations: any[] = [];
	let toolNames = ["hosted_read", "hosted_write"];
	let listRequests = 0;
	let failDiscovery = false;
	const remote = createServer(async (request, response) => {
		const url = new URL(request.url!, origin);
		const json = (value: unknown, status = 200) =>
			response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			json({
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				scopes_supported: ["connections:use", "apps:write"],
			});
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			json({
				issuer: origin,
				authorization_endpoint: `${origin}/oauth/authorize`,
				token_endpoint: `${origin}/oauth/token`,
				registration_endpoint: `${origin}/oauth/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
			return;
		}
		let raw = "";
		for await (const chunk of request) raw += chunk.toString();
		if (url.pathname === "/oauth/register") {
			const input = JSON.parse(raw);
			registrations.push(input);
			json({ ...input, client_id: `client-${++next}`, client_id_issued_at: 1 });
			return;
		}
		if (url.pathname === "/oauth/token") {
			const input = new URLSearchParams(raw);
			const client = input.get("client_id");
			if (!client || input.get("code") !== `code-${client}` || !input.get("code_verifier")) {
				json({ error: "invalid_grant" }, 400);
				return;
			}
			json({
				access_token: `synthetic-access-${client}`,
				refresh_token: `synthetic-refresh-${client}`,
				token_type: "Bearer",
				expires_in: 3600,
				scope: "connections:use apps:write",
			});
			return;
		}
		if (url.pathname !== "/mcp") {
			response.writeHead(404).end();
			return;
		}
		const bearer = request.headers.authorization;
		if (!bearer) {
			response
				.writeHead(401, {
					"WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				})
				.end();
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const message = JSON.parse(raw);
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		let result: unknown = {};
		if (message.method === "initialize")
			result = {
				protocolVersion: message.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "hosted-fixture", version: "1" },
			};
		if (message.method === "tools/list") {
			listRequests++;
			if (failDiscovery) {
				response.writeHead(503).end();
				return;
			}
			result = {
				ttlMs: cacheTtlMs,
				tools: toolNames.map((name) => ({
					name,
					inputSchema: { type: "object", additionalProperties: false },
				})),
			};
		}
		if (message.method === "tools/call" && message.params.name === "hosted_write") {
			writes++;
			response.destroy();
			return;
		}
		if (message.method === "tools/call")
			result = {
				content: [{ type: "text", text: bearer.replace("Bearer synthetic-access-", "") }],
			};
		json({ jsonrpc: "2.0", id: message.id, result });
	});
	await new Promise<void>((resolve, reject) => {
		remote.once("error", reject);
		remote.listen(0, "127.0.0.1", resolve);
	});
	origin = `http://127.0.0.1:${(remote.address() as any).port}`;
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				remote.closeAllConnections();
				remote.close(() => resolve());
			}),
	);
	const root = await mkdtemp(join(tmpdir(), "desktop-oauth-test-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const values = new Map<string, string>();
	const entries: EntryFactory = async (name) => ({
		getPassword: () => values.get(name) ?? null,
		setPassword: (value) => {
			values.set(name, value);
		},
		deletePassword: () => {
			values.delete(name);
		},
	});
	const manager = new DesktopManager(root, resolve("resources"), origin, { entries });
	await manager.initialize();
	cleanup.push(() => manager.shutdown());
	const opened: string[] = [];
	const hosted = new HostedConnections(manager, (url) => opened.push(url));
	cleanup.push(() => hosted.shutdown());
	async function approve(id: string) {
		await hosted.connect(id);
		expect(hosted.status(id).hosted).toBe("connecting");
		const authorization = new URL(opened.at(-1)!);
		expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
		const callback = new URL(authorization.searchParams.get("redirect_uri")!);
		callback.searchParams.set("state", "wrong-state");
		callback.searchParams.set("code", `code-${authorization.searchParams.get("client_id")}`);
		callback.searchParams.set("iss", origin);
		expect((await fetch(callback)).status).toBe(400);
		callback.searchParams.set("state", authorization.searchParams.get("state")!);
		expect((await fetch(callback)).status).toBe(200);
		await expect.poll(() => hosted.status(id).hosted, { timeout: 3000 }).toBe("connected");
	}
	return {
		manager,
		hosted,
		approve,
		root,
		registrations,
		opened,
		writes: () => writes,
		token: (id: string) => values.get(`client:${id}`)!,
		setTools: (names: string[]) => {
			toolNames = names;
		},
		listRequests: () => listRequests,
		failDiscovery: (value: boolean) => {
			failDiscovery = value;
		},
	};
}

it("refreshes the hosted catalog on downstream listing without change notifications", async () => {
	const f = await fixture(60000);
	const a = await f.manager.registerClient("Catalog refresh");
	await f.approve(a.id);
	const server = await startMcpServer(f.manager, f.hosted);
	cleanup.push(() => server.close());
	const client = new Client({ name: "Catalog refresh", version: "1" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(server.endpoint), {
			requestInit: { headers: { Authorization: `Bearer ${f.token(a.id)}` } },
		}),
	);
	cleanup.push(() => client.close());
	expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
		"hosted_read",
		"hosted_write",
	]);
	f.setTools(["newly_enabled_tool"]);
	expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["newly_enabled_tool"]);
	expect((await client.callTool({ name: "hosted_read", arguments: {} })).isError).toBe(true);
	expect((await client.callTool({ name: "newly_enabled_tool", arguments: {} })).isError).not.toBe(
		true,
	);
});

it("coalesces concurrent discovery and recovers after an upstream catalog failure", async () => {
	const f = await fixture(60000);
	const a = await f.manager.registerClient("Concurrent refresh");
	await f.approve(a.id);
	const before = f.listRequests();
	f.setTools(["newly_enabled_tool"]);
	const catalogs = await Promise.all([f.hosted.refreshTools(a.id), f.hosted.refreshTools(a.id)]);
	expect(
		f.listRequests(),
		JSON.stringify({
			status: f.hosted.status(a.id),
			catalogs: catalogs.map((tools) => tools.map((tool) => tool.name)),
		}),
	).toBe(before + 1);
	expect(catalogs.map((tools) => tools.map((tool) => tool.name))).toEqual([
		["newly_enabled_tool"],
		["newly_enabled_tool"],
	]);
	f.failDiscovery(true);
	expect(await f.hosted.refreshTools(a.id)).toEqual([]);
	expect(f.hosted.tools(a.id)).toEqual([]);
	expect(f.hosted.status(a.id).hosted).toBe("connected");
	f.failDiscovery(false);
	expect((await f.hosted.refreshTools(a.id)).map((tool) => tool.name)).toEqual([
		"newly_enabled_tool",
	]);
});

it("recovers from a transient discovery failure triggered by a tool-list notification", async () => {
	const handlers = vi.spyOn(Client.prototype, "setNotificationHandler");
	const f = await fixture();
	const a = await f.manager.registerClient("Notification refresh");
	await f.approve(a.id);
	const notify = handlers.mock.calls
		.filter(([schema]) => schema === "notifications/tools/list_changed")
		.at(-1)![1] as unknown as (notification: unknown) => Promise<void>;
	f.failDiscovery(true);
	await notify({ method: "notifications/tools/list_changed" });
	expect(f.hosted.tools(a.id)).toEqual([]);
	expect(f.hosted.status(a.id)).toMatchObject({
		hosted: "connected",
		error: expect.stringContaining("catalog unavailable"),
	});
	f.failDiscovery(false);
	f.setTools(["recovered_tool"]);
	expect((await f.hosted.refreshTools(a.id)).map((tool) => tool.name)).toEqual(["recovered_tool"]);
	expect(f.hosted.status(a.id)).toEqual({ hosted: "connected", error: undefined });
	f.failDiscovery(true);
	await notify({ method: "notifications/tools/list_changed" });
	f.failDiscovery(false);
	await notify({ method: "notifications/tools/list_changed" });
	expect(f.hosted.tools(a.id).map((tool) => tool.name)).toEqual(["recovered_tool"]);
	expect(f.hosted.status(a.id)).toEqual({ hosted: "connected", error: undefined });
});

it("ignores obsolete notification callbacks and their in-flight failures after reconnecting", async () => {
	const handlers = vi.spyOn(Client.prototype, "setNotificationHandler");
	const f = await fixture();
	const a = await f.manager.registerClient("Reconnected notification");
	await f.approve(a.id);
	const notify = handlers.mock.calls
		.filter(([schema]) => schema === "notifications/tools/list_changed")
		.at(-1)![1] as unknown as (notification: unknown) => Promise<void>;
	let fail!: (error: Error) => void;
	const discovery = vi.spyOn(Client.prototype, "listTools").mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			}),
	);
	const pending = notify({ method: "notifications/tools/list_changed" });
	await f.hosted.disconnect(a.id);
	f.setTools(["new_connection_tool"]);
	await f.approve(a.id);
	fail(new Error("Old discovery failed"));
	await pending;
	const before = discovery.mock.calls.length;
	await notify({ method: "notifications/tools/list_changed" });
	expect(discovery.mock.calls).toHaveLength(before);
	expect(f.hosted.status(a.id)).toEqual({ hosted: "connected", error: undefined });
	expect(f.hosted.tools(a.id).map((tool) => tool.name)).toEqual(["new_connection_tool"]);
});
it("uses distinct PKCE grants per downstream client, validates callback state, and encrypts tokens", async () => {
	const f = await fixture(),
		a = await f.manager.registerClient("Codex"),
		b = await f.manager.registerClient("Claude");
	await f.approve(a.id);
	await f.approve(b.id);
	const first: any = await f.hosted.call(a.id, "hosted_read", {}, new AbortController().signal);
	const second: any = await f.hosted.call(b.id, "hosted_read", {}, new AbortController().signal);
	expect(first.content[0].text).toBe("client-1");
	expect(second.content[0].text).toBe("client-2");
	expect(f.registrations.map((r) => r.client_name)).toEqual([
		"Laplace Desktop · Codex",
		"Laplace Desktop · Claude",
	]);
	for (const name of await readdir(f.root))
		if (name.endsWith(".enc"))
			expect((await readFile(join(f.root, name))).toString()).not.toContain("synthetic-access");
	await f.hosted.shutdown();
	const restored = new HostedConnections(f.manager, () => {
		throw new Error("Restoration must not open a browser");
	});
	cleanup.push(() => restored.shutdown());
	await restored.restore();
	expect(restored.status(a.id).hosted).toBe("connected");
	expect(restored.status(b.id).hosted).toBe("connected");
	expect(
		((await restored.call(a.id, "hosted_read", {}, new AbortController().signal)) as any).content[0]
			.text,
	).toBe("client-1");
	expect(f.registrations).toHaveLength(2);
	await restored.shutdown();
	await f.hosted.disconnect(a.id);
	await expect(
		f.hosted.call(a.id, "hosted_read", {}, new AbortController().signal),
	).rejects.toThrow("unavailable");
	await f.hosted.connect(b.id, false);
	expect(
		(await f.hosted.call(b.id, "hosted_read", {}, new AbortController().signal)).isError,
	).not.toBe(true);
});

it("does not replay a hosted call after its response is lost", async () => {
	const f = await fixture(),
		a = await f.manager.registerClient("Codex");
	await f.approve(a.id);
	await expect(
		f.hosted.call(a.id, "hosted_write", {}, new AbortController().signal),
	).rejects.toThrow("not replayed");
	await expect(
		f.hosted.call(a.id, "hosted_write", {}, new AbortController().signal),
	).rejects.toThrow("unavailable");
	expect(f.writes()).toBe(1);
});

it("requests desktop management only after explicit opt-in and opens a new consent flow", async () => {
	const f = await fixture(),
		client = await f.manager.registerClient("Management scope");
	await f.approve(client.id);
	expect(f.registrations[0].scope).toBe("connections:use apps:write");
	await f.hosted.connect(client.id, true, true);
	expect(f.registrations.at(-1).scope).toBe("connections:use apps:write desktop:manage");
	expect(f.hosted.status(client.id).hosted).toBe("connecting");
	expect(f.opened).toHaveLength(2);
});
