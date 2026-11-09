import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, copyFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serverConfig } from "@repo/local-mcp-core/config";
import type { EntryFactory } from "@repo/local-mcp-core/store";
import { BrowserApprovals } from "@repo/local-runtime/browser-approvals";
import { CatalogInstaller } from "@repo/local-runtime/catalog";
import { ConnectorManagement, connectorManagementTools } from "@repo/local-runtime/connector-tools";
import { CredentialBroker } from "@repo/local-runtime/credentials";
import { bundleCatalog, bundleAvailable } from "@repo/local-runtime/library-catalog";
import { DesktopManager } from "@repo/local-runtime/manager";
import { startMcpServer } from "@repo/local-runtime/server";
import { browserExtensionId } from "@repo/local-runtime/shared/browser-extension-id";
import { ycBrowserIdentity } from "@repo/local-runtime/shared/yc-browser";
import { build } from "esbuild";
import { afterAll, afterEach, expect, it, vi } from "vitest";

import { listBrowserRequests } from "../src/shared/browser-requests";
// This suite exercises the explicitly enabled browser-extension installation path.
vi.mock("@repo/local-runtime/shared/browser-feature", () => ({
	browserConnectionsEnabled: () => true,
}));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});
async function fixture(
	hostedOverride?: Parameters<typeof startMcpServer>[1],
	setup?: { fetch?: typeof fetch },
) {
	const root = await mkdtemp(join(tmpdir(), "desktop-server-test-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	if (process.platform === "win32") {
		await mkdir(join(root, "resources/runtimes"), { recursive: true });
		await copyFile(
			resolve("resources/runtimes/process-host.exe"),
			join(root, "resources/runtimes/process-host.exe"),
		);
	}
	const secrets = new Map<string, string>();
	const entries: EntryFactory = async (name) => ({
		getPassword: () => secrets.get(name) ?? null,
		setPassword: (value) => {
			secrets.set(name, value);
		},
		deletePassword: () => {
			secrets.delete(name);
		},
	});
	const manager = new DesktopManager(
		root,
		join(root, "resources"),
		"https://connect.fixture.invalid",
		{ entries },
	);
	cleanup.push(() => manager.shutdown());
	await manager.initialize();
	if (!setup)
		await manager.addServers([
			serverConfig.parse({
				id: "fixture",
				name: "Fixture",
				transport: "stdio",
				command: process.execPath,
				args: [resolve("tests/fixtures/connector.mjs")],
			}),
		]);
	const hosted = hostedOverride ?? {
		tools: () => [],
		call: async () => {
			throw new Error("Unknown hosted tool");
		},
	};
	const credentials = new CredentialBroker(
		root,
		resolve("resources"),
		() => manager.changed(),
		entries,
	);
	await credentials.initialize();
	cleanup.push(async () => credentials.close());
	const browserApprovals = new BrowserApprovals(manager);
	await browserApprovals.initialize();
	cleanup.push(() => browserApprovals.close());
	const installer = new CatalogInstaller(manager, {
		browserApprovals,
		root,
		resources: manager.resources,
		nodePath: process.execPath,
		onChange: () => manager.changed(),
		fetch: setup?.fetch,
	});
	const server = await startMcpServer(
		manager,
		hosted,
		credentials,
		setup ? new ConnectorManagement(manager, installer, undefined, browserApprovals) : undefined,
	);
	cleanup.push(() => server.close());
	async function connect(name: string, modern = true) {
		const registration = await manager.registerClient(name),
			token = secrets.get(`client:${registration.id}`)!;
		const client = new Client(
			{ name, version: "1" },
			modern
				? { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } }
				: { capabilities: {} },
		);
		const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
			reconnectionOptions: {
				maxRetries: 0,
				initialReconnectionDelay: 1000,
				maxReconnectionDelay: 1000,
				reconnectionDelayGrowFactor: 1,
			},
		});
		await client.connect(transport);
		if (modern) await client.listen({ toolsListChanged: true });
		cleanup.push(() => client.close());
		return { ...registration, token, client, transport };
	}
	return { root, manager, server, connect, credentials, installer, browserApprovals };
}

it.each([false, true])(
	"routes a client through both legacy and modern connectors (modern client=%s)",
	async (modern) => {
		const f = await fixture();
		await f.manager.addServers([
			serverConfig.parse({
				id: "modern",
				name: "Modern",
				transport: "stdio",
				command: process.execPath,
				args: [resolve("tests/fixtures/modern-connector.mjs")],
				protocolVersion: "2026-07-28",
			}),
		]);
		const { client, transport } = await f.connect("Protocol matrix", modern);
		const tools = (await client.listTools()).tools;
		const legacyTool = tools.find((tool) => tool.title === "Fixture: read")!;
		const modernTool = tools.find((tool) => tool.title === "Modern: read")!;
		const legacyResult = await client.callTool({ name: legacyTool.name, arguments: {} });
		expect(legacyResult.content[0]).toMatchObject({ type: "text" });
		if (legacyResult.content[0].type === "text")
			expect(JSON.parse(legacyResult.content[0].text).name).toBe("read");
		expect(await client.callTool({ name: modernTool.name, arguments: {} })).toMatchObject({
			content: [{ type: "text", text: "modern" }],
		});
		expect(client.getProtocolEra()).toBe(modern ? "modern" : "legacy");
		expect(transport.sessionId).toBeUndefined();
	},
);

async function setupCall(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result: any = await client.callTool({
		name: `local_connectors_${name}`,
		arguments: args,
	});
	expect(result.isError, JSON.stringify(result)).not.toBe(true);
	return JSON.parse(result.content[0].text);
}

it("limits active calls to 32 per registration and 128 overall, independently of subscriptions", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const dispatch = vi.fn(async () => {
		await gate;
		return { content: [{ type: "text" as const, text: "done" }] };
	});
	const f = await fixture(
		{ tools: () => [{ name: "wait", inputSchema: { type: "object" } }], call: dispatch },
		{},
	);
	const clients = await Promise.all(Array.from({ length: 5 }, (_, i) => f.connect(`Limit ${i}`)));
	const pending: Array<ReturnType<Client["callTool"]>> = [];
	try {
		for (let i = 0; i < 4; i++) {
			for (let j = 0; j < 32; j++)
				pending.push(clients[i].client.callTool({ name: "wait", arguments: {} }));
			await vi.waitFor(() => expect(f.server.diagnostics().activeCalls).toBe((i + 1) * 32), {
				timeout: 5000,
			});
			const busy = await clients[i].client.callTool({ name: "wait", arguments: {} });
			expect(busy).toMatchObject({
				isError: true,
				_meta: { "com.laplace/dispatch": "not_started" },
			});
		}
		expect((await clients[4].client.callTool({ name: "wait", arguments: {} })).isError).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(128);
		expect(f.server.diagnostics().subscriptions).toBe(5);
	} finally {
		release();
		await Promise.all(pending);
	}
	await vi.waitFor(() => expect(f.server.diagnostics().activeCalls).toBe(0));
	expect((await clients[0].client.callTool({ name: "wait", arguments: {} })).isError).not.toBe(
		true,
	);
	expect(f.server.diagnostics().events.length).toBeLessThanOrEqual(50);
});

it("isolates identical wire IDs by principal and invocation, and releases disconnected and revoked calls", async () => {
	const executing = new Map<
		string,
		{ clientId: string; signal: AbortSignal; release: () => void }
	>();
	const f = await fixture(
		{
			tools: () => [{ name: "wait", inputSchema: { type: "object" } }],
			call: async (clientId, _name, input, signal) => {
				await new Promise<void>((resolve) => {
					executing.set(String(input.label), { clientId, signal, release: resolve });
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: String(input.label) }] };
			},
		},
		{},
	);
	const a = await f.connect("A"),
		b = await f.connect("B");
	const responses: string[] = [];
	const post = (token: string, label: string, signal?: AbortSignal) =>
		fetch(f.server.endpoint, {
			method: "POST",
			signal,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "tools/call",
				"Mcp-Name": "wait",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: {
					name: "wait",
					arguments: { label },
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		})
			.then((response) => response.text())
			.then((text) => {
				responses.push(text);
				return text;
			})
			.catch(() => "disconnected");
	const abort = new AbortController();
	const requests = [post(a.token, "a1", abort.signal), post(a.token, "a2"), post(b.token, "b")];
	await vi.waitFor(() => expect(executing.size, responses.join("\n")).toBe(3));
	abort.abort();
	await vi.waitFor(() => expect(f.server.diagnostics().activeCalls).toBe(2));
	expect(executing.get("a2")!.signal.aborted).toBe(false);
	expect(executing.get("b")!.signal.aborted).toBe(false);
	await f.manager.revokeClient(a.id);
	await vi.waitFor(() =>
		expect(f.server.diagnostics()).toMatchObject({ activeCalls: 1, subscriptions: 1 }),
	);
	expect(executing.get("a2")!.signal.aborted).toBe(true);
	executing.get("b")!.release();
	const results = await Promise.all(requests);
	expect(results[2]).toContain("b");
	await vi.waitFor(() => expect(f.server.diagnostics().activeCalls).toBe(0));
});

it("counts queued calls and reauthorizes before dispatch when a client's grant is revoked", async () => {
	const f = await fixture(undefined, {});
	const releaseFile = join(f.root, "release"),
		effects = join(f.root, "effects");
	await f.manager.addServers([
		serverConfig.parse({
			id: "queued",
			name: "Queued",
			transport: "stdio",
			command: process.execPath,
			args: [resolve("tests/fixtures/connector.mjs"), "--release-file", releaseFile],
			env: { EFFECT_FILE: effects },
		}),
	]);
	const a = await f.connect("Runner"),
		b = await f.connect("Queued");
	const name = (await a.client.listTools()).tools.find(
		(tool) => tool.title === "Queued: read",
	)!.name;
	const first = a.client.callTool({ name, arguments: {} });
	await vi.waitFor(async () => expect(await readFile(effects, "utf8")).toBe("read\n"));
	const second = b.client.callTool({ name, arguments: {} });
	await vi.waitFor(() => expect(f.server.diagnostics().activeCalls).toBe(2));
	await f.manager.setClientTools(b.id, []);
	expect((await second).isError).toBe(true);
	await vi.waitFor(() => expect(f.server.diagnostics().activeCalls).toBe(1));
	await writeFile(releaseFile, "release");
	expect((await first).isError).not.toBe(true);
	expect(await readFile(effects, "utf8")).toBe("read\n");
	await vi.waitFor(() => expect(f.server.diagnostics().activeCalls).toBe(0));
});

it("serves the bundled YC editor only for clients allowed to use the YC connection", async () => {
	const f = await fixture(undefined, {});
	await f.manager.addServers([
		serverConfig.parse({
			id: "yc",
			name: "YC fixture",
			identity: ycBrowserIdentity,
			transport: "stdio",
			command: process.execPath,
			args: [resolve("tests/fixtures/yc-connector.mjs")],
		}),
	]);
	const { client, id } = await f.connect("YC UI");
	await vi.waitFor(async () =>
		expect(
			(await client.listTools()).tools.some((tool) => tool.name === "render_yc_application"),
		).toBe(true),
	);
	const tools = (await client.listTools()).tools;
	expect(tools.find((tool) => tool.name === "render_yc_application")?._meta).toMatchObject({
		ui: { visibility: ["model"], resourceUri: "ui://laplace/yc-application-v2.html" },
	});
	expect(tools.find((tool) => tool.name === "save_yc_draft")?._meta).toMatchObject({
		ui: { visibility: ["app"] },
	});
	const resources = (await client.listResources()).resources;
	expect(resources).toHaveLength(2);
	expect((await client.readResource({ uri: resources[0].uri })).contents[0]).toMatchObject({
		mimeType: "text/html;profile=mcp-app",
	});
	expect(
		(await client.callTool({ name: "render_yc_application", arguments: {} })).structuredContent,
	).toMatchObject({
		kind: "yc_application",
		state: "applications",
		accountId: "desktop",
		connectionName: "yc",
	});
	await f.manager.setClientTools(id, []);
	expect((await client.listResources()).resources).toEqual([]);
	await expect(client.readResource({ uri: resources[0].uri })).rejects.toThrow();
	expect((await client.callTool({ name: "get_yc_application_view", arguments: {} })).isError).toBe(
		true,
	);
});

it("cancels an editor save when its write grant is revoked while read grants remain", async () => {
	const f = await fixture(undefined, {}),
		started = join(f.root, "save-started");
	await f.manager.addServers([
		serverConfig.parse({
			id: "yc",
			name: "YC fixture",
			identity: ycBrowserIdentity,
			transport: "stdio",
			command: process.execPath,
			args: [resolve("tests/fixtures/yc-connector.mjs")],
			env: { SAVE_STARTED: started },
		}),
	]);
	const { client, id } = await f.connect("Writer");
	const localReads = (await client.listTools()).tools
		.filter(
			(tool) =>
				tool.title === "YC fixture: list_applications" ||
				tool.title === "YC fixture: read_application",
		)
		.map((tool) => tool.name);
	const saving = client.callTool({
		name: "save_yc_draft",
		arguments: {
			accountId: "desktop",
			connectionName: "yc",
			applicationId: "12345678-1234-4234-8234-123456789abc",
			changes: { name: "Synthetic" },
			expectedRevision: "a".repeat(64),
			confirm: true,
		},
	});
	await vi.waitFor(async () => expect(await readFile(started, "utf8")).toBe("started"));
	await f.manager.setClientTools(id, localReads);
	expect(await saving).toMatchObject({ isError: true });
	await vi.waitFor(() => expect(f.server.diagnostics().activeCalls).toBe(0));
});

it("reclaims abandoned connections without DELETE across 100 reconnections and 32 simultaneous clients", async () => {
	const f = await fixture(undefined, {});
	const registration = await f.connect("Shared registration");
	await registration.client.close();
	const connect = async (modern = true) => {
		const client = new Client(
			{ name: "Repeated bridge", version: "1" },
			{ versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" } },
		);
		const transport = new StreamableHTTPClientTransport(new URL(f.server.endpoint), {
			requestInit: { headers: { Authorization: `Bearer ${registration.token}` } },
		});
		await client.connect(transport);
		expect(transport.sessionId).toBeUndefined();
		if (modern) await client.listen({ toolsListChanged: true });
		return client;
	};
	for (let i = 0; i < 100; i++) {
		const client = await connect(i % 2 === 0);
		expect((await client.listTools()).tools.length).toBeGreaterThan(0);
		await client.close();
	}
	const clients = await Promise.all(Array.from({ length: 32 }, () => connect()));
	try {
		await Promise.all(
			clients.map(async (client) =>
				expect((await client.listTools()).tools.length).toBeGreaterThan(0),
			),
		);
		expect(f.server.sessionCount()).toBe(0);
		expect(f.server.diagnostics().subscriptions).toBe(32);
	} finally {
		await Promise.all(clients.map((client) => client.close()));
	}
	await vi.waitFor(() =>
		expect(f.server.diagnostics()).toMatchObject({
			subscriptions: 0,
			activeRequests: 0,
			activeCalls: 0,
		}),
	);
}, 30_000);

it("exposes setup with no connectors, reserves names, and enforces per-client setup grants", async () => {
	let collision = false;
	const f = await fixture(
		{ tools: () => (collision ? [connectorManagementTools[0]!] : []), call: vi.fn() },
		{},
	);
	const a = await f.connect("Setup agent");
	expect(
		(await a.client.listTools()).tools
			.filter((t) => !t.name.startsWith("local_credential"))
			.map((t) => t.name),
	).toEqual(connectorManagementTools.map((t) => t.name));
	expect(
		(await setupCall(a.client, "list")).catalog.find((c: any) => c.serverId === "slack").fields,
	).toEqual(expect.arrayContaining([expect.objectContaining({ key: "workspace" })]));
	await f.manager.setClientTools(a.id, ["local_connectors_list"]);
	expect((await a.client.listTools()).tools.map((t) => t.name)).toEqual(["local_connectors_list"]);
	expect(
		(
			await a.client.callTool({
				name: "local_connectors_install",
				arguments: { catalogId: "slack-mcp-server" },
			})
		).isError,
	).toBe(true);
	collision = true;
	await expect(a.client.listTools()).rejects.toThrow("Conflicting");
});

it("previews and adds custom servers, reports saved startup failure, and never returns credentials", async () => {
	const f = await fixture(undefined, {}),
		a = await f.connect("Custom setup");
	let changes = 0;
	a.client.setNotificationHandler("notifications/tools/list_changed", async () => {
		changes++;
	});
	const config = {
		id: "custom",
		name: "Custom",
		transport: "stdio",
		command: process.execPath,
		args: [resolve("tests/fixtures/connector.mjs")],
		env: { TEST_SECRET: "private-setup-value" },
	};
	const preview = await setupCall(a.client, "preview_custom", { config });
	expect(preview.resolvedCommand).toBeTruthy();
	expect(f.manager.listServers()).toHaveLength(0);
	const added = await setupCall(a.client, "add_custom", { config });
	expect(added).toMatchObject({
		saved: true,
		startupSucceeded: true,
		connector: { linkMode: "local-only" },
	});
	await vi.waitFor(() => expect(changes).toBeGreaterThan(0));
	expect((await a.client.listTools()).tools.some((t) => t.title === "Custom: read")).toBe(true);
	expect(
		(await a.client.callTool({ name: "local_connectors_add_custom", arguments: { config } }))
			.isError,
	).toBe(true);
	const failed = await setupCall(a.client, "add_custom", {
		config: { ...config, id: "broken", command: join(f.root, "missing-runtime") },
	});
	expect(failed).toMatchObject({ saved: true, startupSucceeded: false });
	const http = {
		id: "http",
		name: "HTTP",
		transport: "http",
		enabled: false,
		url: "http://127.0.0.1:54321/mcp?token=private-setup-value",
		headers: { Authorization: "Bearer private-setup-value" },
	};
	expect(
		JSON.stringify(await setupCall(a.client, "preview_custom", { config: http })),
	).not.toContain("private-setup-value");
	expect(await setupCall(a.client, "add_custom", { config: http })).toMatchObject({
		saved: true,
		startupSucceeded: null,
	});
	for (const invalid of [
		{ ...config, id: "laplace" },
		{ ...config, args: ["/bridge.cjs"] },
		{ ...http, url: "https://remote.example/mcp" },
	]) {
		expect(
			(
				await a.client.callTool({
					name: "local_connectors_add_custom",
					arguments: { config: invalid },
				})
			).isError,
		).toBe(true);
	}
	for (const value of [preview, added, failed, await setupCall(a.client, "status")])
		expect(JSON.stringify(value)).not.toContain("private-setup-value");
	await f.manager.setClientTools(a.id, ["local_connectors_add_custom", "local_connectors_status"]);
	await setupCall(a.client, "add_custom", { config: { ...config, id: "restricted" } });
	expect((await a.client.listTools()).tools).toHaveLength(2);
});

async function downloadFixture() {
	const entry = bundleCatalog.find((e) => e.recipe === "canvas")!;
	const platform = `${process.platform}-${process.arch}` as any;
	if (!bundleAvailable(entry, platform)) {
		const { candidate, platforms } = entry;
		entry.candidate = true;
		entry.platforms = [...platforms, platform];
		cleanup.push(async () => {
			entry.candidate = candidate;
			entry.platforms = platforms;
		});
	}
	return { catalogId: entry.id, configuration: { canvas_url: "https://canvas.fixture.invalid" } };
}
async function slackFixture(f: Awaited<ReturnType<typeof fixture>>) {
	await mkdir(join(f.manager.resources, "helper"), { recursive: true });
	await build({
		entryPoints: [resolve("../../packages/local-runtime/src/slack-browser.ts")],
		outfile: join(f.manager.resources, "helper/slack-browser.cjs"),
		platform: "node",
		format: "cjs",
		bundle: true,
	});
	return {
		catalogId: "slack-mcp-server",
		configuration: { workspace: "https://fixture.slack.com" },
	};
}

it.each(["app", "chat"])(
	"installs Slack over MCP and verifies tools with %s approval",
	async (approvalMode) => {
		const f = await fixture(undefined, {}),
			a = await f.connect("Slack setup");
		const input = await slackFixture(f);
		const job = await setupCall(a.client, "install", input);
		await a.client.close();
		const reconnect = new Client({ name: "Reconnected", version: "1" }, { capabilities: {} });
		await reconnect.connect(
			new StreamableHTTPClientTransport(new URL(f.server.endpoint), {
				requestInit: { headers: { Authorization: `Bearer ${a.token}` } },
			}),
		);
		cleanup.push(() => reconnect.close());
		await vi.waitFor(async () =>
			expect((await setupCall(reconnect, "status", { jobId: job.id })).jobs[0]).toMatchObject({
				status: "completed",
				state: "authentication_required",
			}),
		);
		expect(f.manager.getServerConfig("slack").enabled).toBe(false);
		expect(
			(await reconnect.callTool({ name: "local_connectors_install", arguments: input })).isError,
		).toBe(true);
		const auth = await setupCall(reconnect, "authenticate", { id: "slack" });
		let approval: any;
		await vi.waitFor(
			async () => {
				approval = (await setupCall(reconnect, "status", { jobId: auth.id })).jobs[0]
					.browserApproval;
				expect(
					approval,
					JSON.stringify({ jobs: f.installer.jobs(), servers: f.manager.listServers() }),
				).toBeTruthy();
			},
			{ timeout: 5000 },
		);
		expect(approval.pairingUrl).toBeUndefined();
		const pendingRequest = (await listBrowserRequests()).find(
			(item) => item.id === approval.requestId,
		)!;
		const url = new URL(pendingRequest.pairingUrl);
		const post = async (path: string, body: unknown, token?: string) =>
			(
				await fetch(url.origin + path, {
					method: "POST",
					headers: {
						Origin: `chrome-extension://${browserExtensionId}`,
						"Content-Type": "application/json",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
					body: JSON.stringify(body),
				})
			).json();

		const code = url.hash.slice(1),
			candidate = {
				id: randomUUID(),
				revision: randomUUID(),
				profileId: randomUUID(),
				profileLabel: "Chrome fixture",
				identity: {
					workspace: "https://fixture.slack.com",
					teamId: "T123456",
					userId: "U123456",
				},
			};
		await post("/review", {
			code,
			profileId: candidate.profileId,
			profileLabel: candidate.profileLabel,
			candidates: [candidate],
			hint: "discovering",
		});
		let card: any;
		await vi.waitFor(
			async () => {
				card = await reconnect.callTool({
					name: "local_connectors_browser_show",
					arguments: { requestId: approval.requestId },
				});
				expect(card.structuredContent?.state).toBe("approval_required");
			},
			{ timeout: 5000 },
		);
		expect(card._meta.browserApprovalCapabilities[candidate.id]).toBeTruthy();
		expect(JSON.stringify(card.content)).not.toContain(
			card._meta.browserApprovalCapabilities[candidate.id],
		);
		const chatReview =
			approvalMode === "chat"
				? await reconnect.callTool({
						name: "local_connectors_browser_prompt",
						arguments: { requestId: approval.requestId },
					})
				: undefined;
		if (chatReview) {
			expect(chatReview._meta).toBeUndefined();
			expect(chatReview.structuredContent).toMatchObject({
				profile: candidate.profileLabel,
				account: candidate.identity,
			});
		}
		const accepted = await reconnect.callTool(
			approvalMode === "chat"
				? {
						name: "local_connectors_browser_confirm",
						arguments: {
							requestId: approval.requestId,
							reviewId: (chatReview!.structuredContent as any).reviewId,
							confirmed: true,
						},
					}
				: {
						name: "local_connectors_browser_approve",
						arguments: {
							requestId: approval.requestId,
							capability: card._meta.browserApprovalCapabilities[candidate.id],
						},
					},
		);
		expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
		const decision = await post("/decision", { code, profileId: candidate.profileId });
		const { token } = await post("/pair", {
			code,
			candidateId: candidate.id,
			authorization: decision.authorization,
			identity: candidate.identity,
		});
		expect(token).toBeTruthy();

		let pumping = true;
		const pump = (async () => {
			while (pumping) {
				const { request } = await post("/next", {}, token);
				if (request)
					await post("/result", { id: request.id, ok: true, result: { channels: [] } }, token);
				await new Promise((r) => setTimeout(r, 20));
			}
		})().catch(() => {});
		cleanup.push(async () => {
			pumping = false;
			await pump;
		});
		await vi.waitFor(
			async () =>
				expect((await setupCall(reconnect, "status", { jobId: auth.id })).jobs[0]).toMatchObject({
					status: "completed",
					state: "verified",
				}),
			{ timeout: 5000 },
		);
		expect(
			(await reconnect.listTools()).tools.some((t) => t.title?.endsWith(": channels_list")),
		).toBe(true);
		const verify = await setupCall(reconnect, "verify", { id: "slack" });
		await vi.waitFor(async () =>
			expect((await setupCall(reconnect, "status", { jobId: verify.id })).jobs[0].state).toBe(
				"verified",
			),
		);
		const read = vi.spyOn(f.manager, "catalogSetupCall").mockResolvedValue({
			isError: true,
			content: [{ type: "text", text: "private-provider-error" }],
		});
		try {
			const failed = await setupCall(reconnect, "verify", { id: "slack" });
			await vi.waitFor(
				async () =>
					expect((await setupCall(reconnect, "status", { jobId: failed.id })).jobs[0].state).toBe(
						"failed",
					),
				{ timeout: 5000 },
			);
			expect(f.manager.getServerConfig("slack").enabled).toBe(false);
			expect(JSON.stringify(await setupCall(reconnect, "status"))).not.toContain(
				"private-provider-error",
			);
		} finally {
			read.mockRestore();
		}
	},
);

it.each(["cancel", "permission", "revoke"])(
	"ends browser approval when setup is cancelled by %s",
	async (reason) => {
		const f = await fixture(undefined, {}),
			a = await f.connect("Browser consent");
		const input = await slackFixture(f);
		const installed = await setupCall(a.client, "install", input);
		await vi.waitFor(() =>
			expect(f.installer.jobs().find((j) => j.id === installed.id)?.status).toBe("completed"),
		);
		const auth = await setupCall(a.client, "authenticate", { id: "slack" });
		await vi.waitFor(
			() => expect(f.installer.jobs().find((j) => j.id === auth.id)?.browserApproval).toBeTruthy(),
			{ timeout: 5000 },
		);
		expect((await a.client.listTools()).tools.some((t) => t.name.includes("laplace_browser"))).toBe(
			false,
		);
		if (reason === "cancel") await setupCall(a.client, "cancel", { jobId: auth.id });
		else if (reason === "permission")
			await f.manager.setClientTools(a.id, ["local_connectors_status"]);
		else await f.manager.revokeClient(a.id);
		await vi.waitFor(() =>
			expect(f.installer.jobs().find((j) => j.id === auth.id)?.status).toBe("cancelled"),
		);
		expect(f.manager.getServerConfig("slack").enabled).toBe(false);
		expect(f.installer.jobs().find((j) => j.id === auth.id)?.browserApproval).toBeUndefined();
	},
);

it.each(["cancel", "permission", "revoke"])(
	"cancels pending installation on %s without attaching a connector",
	async (reason) => {
		const fetcher = vi.fn(
			(_url: any, init: any) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
						once: true,
					});
				}),
		);
		const f = await fixture(undefined, { fetch: fetcher }),
			a = await f.connect("Cancelled setup");
		const input = await downloadFixture();
		const job = await setupCall(a.client, "install", input);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
		expect(
			(await a.client.callTool({ name: "local_connectors_install", arguments: input })).isError,
		).toBe(true);
		if (reason === "cancel") await setupCall(a.client, "cancel", { jobId: job.id });
		else if (reason === "permission")
			await f.manager.setClientTools(a.id, ["local_connectors_status"]);
		else await f.manager.revokeClient(a.id);
		await vi.waitFor(() =>
			expect(f.installer.jobs().find((j) => j.id === job.id)?.status).toBe("cancelled"),
		);
		expect(f.manager.listServers()).toHaveLength(0);
	},
);

it("reports failed downloads without leaking provider errors", async () => {
	const f = await fixture(undefined, {
			fetch: async () => {
				throw new Error("secret-provider-value");
			},
		}),
		a = await f.connect("Failed setup");
	const input = await downloadFixture();
	const job = await setupCall(a.client, "install", input);
	await vi.waitFor(async () =>
		expect((await setupCall(a.client, "status", { jobId: job.id })).jobs[0].state).toBe("failed"),
	);
	expect(JSON.stringify(await setupCall(a.client, "status"))).not.toContain(
		"secret-provider-value",
	);
	expect(
		(
			await a.client.callTool({
				name: "local_connectors_install",
				arguments: { ...input, configuration: { workspace: "https://invalid.example" } },
			})
		).isError,
	).toBe(true);
});

it("rejects unavailable catalog platforms without starting a job", async () => {
	const f = await fixture(undefined, {}),
		a = await f.connect("Unsupported platform");
	const entry = bundleCatalog.find((e) => e.recipe === "canvas")!;
	entry.published = false;
	try {
		expect(
			(await setupCall(a.client, "list")).catalog.find((e: any) => e.id === entry.id).available,
		).toBe(false);
		expect(
			(
				await a.client.callTool({
					name: "local_connectors_install",
					arguments: {
						catalogId: entry.id,
						configuration: { workspace: "https://fixture.slack.com" },
					},
				})
			).isError,
		).toBe(true);
		expect(f.installer.jobs()).toHaveLength(0);
	} finally {
		entry.published = true;
	}
});

it("routes hosted tools explicitly even when their name starts with local_ and preserves the result", async () => {
	const result = {
		content: [{ type: "text" as const, text: "fixture" }],
		structuredContent: { ok: true },
		_meta: { fixture: "retained" },
		isError: true,
	};
	const call = vi.fn().mockResolvedValue(result);
	const f = await fixture({
		tools: () => [{ name: "local_remote_tool", inputSchema: { type: "object" } }],
		call,
	});
	const c = await f.connect("Explicit routes");
	expect((await c.client.listTools()).tools.map((tool) => tool.name)).toContain(
		"local_remote_tool",
	);
	expect(
		await c.client.callTool({ name: "local_remote_tool", arguments: { value: 1 } }),
	).toMatchObject(result);
	expect(call).toHaveBeenCalledWith(
		c.id,
		"local_remote_tool",
		{ value: 1 },
		expect.any(AbortSignal),
	);
});

it("rejects conflicting hosted and local tool names without executing either route", async () => {
	let collision: string | undefined;
	const call = vi.fn();
	const f = await fixture({
		tools: () => (collision ? [{ name: collision, inputSchema: { type: "object" } }] : []),
		call,
	});
	const c = await f.connect("Collision check");
	collision = f.manager.tools(c.id)[0]!.name;
	await expect(c.client.listTools()).rejects.toThrow("Conflicting");
	await f.manager.setClientTools(c.id, []);
	await expect(c.client.listTools()).rejects.toThrow("Conflicting");
	expect((await c.client.callTool({ name: collision, arguments: {} })).isError).toBe(true);
	expect(call).not.toHaveBeenCalled();
});

it("keeps the runtime's Laplace discovery tools when hosted Laplace serves the same names", async () => {
	const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "hosted" }] });
	const f = await fixture({
		tools: () =>
			["laplace_status", "laplace_setup", "remote_tool"].map((name) => ({
				name,
				inputSchema: { type: "object" as const },
			})),
		call,
	});
	const c = await f.connect("Hosted discovery");
	const names = (await c.client.listTools()).tools.map((tool) => tool.name);
	expect(names).toContain("remote_tool");
	expect(names.filter((name) => name.startsWith("laplace_"))).toEqual([]);
	expect((await c.client.callTool({ name: "laplace_status", arguments: {} })).isError).toBe(true);
	expect(call).not.toHaveBeenCalled();
	await c.client.callTool({ name: "remote_tool", arguments: {} });
	expect(call).toHaveBeenCalledWith(c.id, "remote_tool", {}, expect.any(AbortSignal));
});

it.each(["disabled", "permissions", "offline"])(
	"reserves local names when the connector becomes %s",
	async (state) => {
		let collision: string | undefined;
		const call = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "hosted" }] });
		const f = await fixture({
			tools: () => (collision ? [{ name: collision, inputSchema: { type: "object" } }] : []),
			call,
		});
		const c = await f.connect("Unavailable route check");
		const previous = f.manager.tools(c.id)[0]!.name;
		if (state === "disabled") await f.manager.setEnabled("fixture", false);
		else if (state === "permissions") await f.manager.setTools("fixture", []);
		else await f.manager.supervisor.stop("fixture");
		collision = previous;
		await expect(c.client.listTools()).rejects.toThrow("reserved local connector namespace");
		expect((await c.client.callTool({ name: previous, arguments: {} })).isError).toBe(true);
		expect(call).not.toHaveBeenCalled();
	},
);
it("discovers credential setup before opt-in without exposing metadata and honors tool restrictions", async () => {
	const f = await fixture(),
		client = await f.connect("Credential test agent");
	expect((await client.client.listTools()).tools.some((t) => t.name === "local_credentials")).toBe(
		true,
	);
	expect(
		(await client.client.listTools()).tools.some((t) => t.name === "local_credential_broker"),
	).toBe(true);
	const setup = await client.client.callTool({
		name: "local_credentials",
		arguments: { action: "status", requestId: randomUUID() },
	});
	expect(JSON.stringify(setup)).toContain("setupRequired");
	const brokerSetup = await client.client.callTool({
		name: "local_credential_broker",
		arguments: {
			requestId: randomUUID(),
			command: {
				action: "start",
				sessionId: randomUUID(),
				targets: [
					{
						id: randomUUID(),
						service: "fixture",
						label: "Fixture",
						location: "local",
						authType: "api_key",
						catalogId: "fixture",
					},
				],
			},
		},
	});
	expect(JSON.stringify(brokerSetup)).toContain("setupRequired");
	expect(
		await client.client.callTool({
			name: "local_credentials",
			arguments: { action: "list", requestId: randomUUID() },
		}),
	).toMatchObject({ isError: true });
	await f.credentials.configure({ enabled: true, clients: [client.id] });
	expect((await client.client.listTools()).tools.some((t) => t.name === "local_credentials")).toBe(
		true,
	);
	const status = await client.client.callTool({
		name: "local_credentials",
		arguments: { action: "status", requestId: crypto.randomUUID() },
	});
	expect(JSON.stringify(status)).toContain("unlocked");
	await f.manager.setClientTools(client.id, []);
	expect((await client.client.listTools()).tools.some((t) => t.name === "local_credentials")).toBe(
		false,
	);
	expect(
		await client.client.callTool({
			name: "local_credentials",
			arguments: { action: "status", requestId: crypto.randomUUID() },
		}),
	).toMatchObject({ isError: true });
});
it("rejects unauthenticated/browser/rebound requests and keeps tokens out of the descriptor", async () => {
	const f = await fixture(),
		c = await f.connect("Codex");
	expect((await fetch(f.server.endpoint)).status).toBe(401);
	expect(
		(
			await fetch(f.server.endpoint, {
				headers: { Authorization: `Bearer ${c.token}`, Origin: "https://attacker.invalid" },
			})
		).status,
	).toBe(403);
	const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
		const request = httpRequest(
			f.server.endpoint,
			{ headers: { Authorization: `Bearer ${c.token}`, Host: "attacker.invalid" } },
			(response) => {
				response.resume();
				resolve(response.statusCode);
			},
		);
		request.once("error", reject);
		request.end();
	});
	expect(reboundStatus).toBe(403);
	expect(await readFile(join(f.root, "endpoint.json"), "utf8")).not.toContain(c.token);
	expect(JSON.stringify(f.manager.status())).not.toContain(c.token);
});
it("shares one upstream across isolated downstream sessions and cannot expose private manager tools", async () => {
	const f = await fixture(),
		a = await f.connect("Codex"),
		b = await f.connect("Claude");
	const tools = (await a.client.listTools()).tools;
	expect(tools.filter((t) => !t.name.startsWith("local_credential"))).toHaveLength(4);
	expect(tools.every((tool) => tool.name.startsWith("local_"))).toBe(true);
	const name = tools.find((t) => t.title === "Fixture: read")!.name;
	const first: any = await a.client.callTool({ name, arguments: {} });
	const second: any = await b.client.callTool({ name, arguments: {} });
	expect(JSON.parse(first.content[0].text).pid).toBe(JSON.parse(second.content[0].text).pid);
	// There are no transport session IDs to transfer across principals.
	expect(a.transport.sessionId).toBeUndefined();
	expect(b.transport.sessionId).toBeUndefined();
	const privateCall: any = await a.client.callTool({ name: "catalogSetupCall", arguments: {} });
	expect(privateCall.isError).toBe(true);
	await a.client.close();
	expect((await b.client.callTool({ name, arguments: {} })).isError).not.toBe(true);
	expect(f.manager.status().servers[0]!.status).toBe("online");
});
it("revocation closes only that downstream client and blocks subsequent bearer use", async () => {
	const f = await fixture(),
		a = await f.connect("Codex"),
		b = await f.connect("Claude");
	await f.manager.revokeClient(a.id);
	expect(
		(await fetch(f.server.endpoint, { headers: { Authorization: `Bearer ${a.token}` } })).status,
	).toBe(401);
	expect(
		(await b.client.listTools()).tools.filter((t) => !t.name.startsWith("local_credential")),
	).toHaveLength(4);
});

it("filters local tools per client and enforces permissions on calls by hidden name", async () => {
	const f = await fixture(),
		a = await f.connect("Codex"),
		b = await f.connect("Claude");
	const tools = (await a.client.listTools()).tools;
	const read = tools.find((tool) => tool.title === "Fixture: read")!;
	const write = tools.find((tool) => tool.title === "Fixture: write")!;
	await f.manager.setClientTools(a.id, [read.name]);
	expect((await a.client.listTools()).tools.map((tool) => tool.name)).toEqual([read.name]);
	expect(
		(await b.client.listTools()).tools.filter((t) => !t.name.startsWith("local_credential")),
	).toHaveLength(4);
	expect((await a.client.callTool({ name: write.name, arguments: {} })).isError).toBe(true);
	expect((await b.client.callTool({ name: write.name, arguments: {} })).isError).not.toBe(true);
	await f.manager.setClientTools(a.id, null);
	expect(
		(await a.client.listTools()).tools.filter((t) => !t.name.startsWith("local_credential")),
	).toHaveLength(4);
});

it("keeps the local broker kill switch and model approval boundary", async () => {
	vi.stubEnv("ENABLE_CREDENTIAL_BROKERING", "false");
	try {
		const f = await fixture(),
			c = await f.connect("Disabled broker");
		expect(
			(await c.client.listTools()).tools.some((t) => t.name.startsWith("local_credential_broker")),
		).toBe(false);
	} finally {
		vi.unstubAllEnvs();
	}
});

// Historical bundle/limited-Slack coverage remains explicit after Mac release activation.
const previousTetheredFlag = vi.hoisted(() => {
	const previous = process.env.LAPLACE_TETHERED_BROWSER_V1;
	process.env.LAPLACE_TETHERED_BROWSER_V1 = "false";
	return previous;
});
afterAll(() => {
	if (previousTetheredFlag === undefined) delete process.env.LAPLACE_TETHERED_BROWSER_V1;
	else process.env.LAPLACE_TETHERED_BROWSER_V1 = previousTetheredFlag;
});
