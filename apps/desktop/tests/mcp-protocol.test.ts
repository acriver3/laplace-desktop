import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import { Server, createMcpHandler } from "@modelcontextprotocol/server";
import { serverConfig, importMcpConfiguration } from "@repo/local-mcp-core/config";
import { Supervisor } from "@repo/local-mcp-core/supervisor";
import { afterEach, expect, it } from "vitest";

import { configurationSummary } from "@repo/local-runtime/imports";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function runtime(config: Record<string, unknown>) {
	const root = await mkdtemp(join(tmpdir(), "laplace-protocol-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const supervisor = new Supervisor(
		root,
		resolve("resources"),
		() => {},
		async () => {},
		async () => {},
	);
	cleanup.push(() => supervisor.shutdown());
	supervisor.configure([serverConfig.parse({ id: "fixture", name: "Fixture", ...config })]);
	return { supervisor, root };
}
async function read(supervisor: Supervisor) {
	return supervisor.call(
		{ localId: "fixture", revision: supervisor.states()[0].revision!, tool: "read", input: {} },
		Date.now() + 5000,
		new AbortController(),
	);
}
function fixtureServer(era: string, fail = false) {
	const server = new Server(
		{ name: "http-fixture", version: "1" },
		{ capabilities: { tools: { listChanged: true } } },
	);
	server.setRequestHandler("tools/list", async () => {
		if (fail) throw Error("fixture discovery failed");
		return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
	});
	server.setRequestHandler("tools/call", async () => ({ content: [{ type: "text", text: era }] }));
	return server;
}
it("pins modern-only stdio connectors without probing or changing existing configuration defaults", async () => {
	const { supervisor } = await runtime({
		transport: "stdio",
		command: process.execPath,
		args: [resolve("tests/fixtures/modern-connector.mjs")],
		protocolVersion: "2026-07-28",
	});
	await supervisor.start("fixture");
	expect((await read(supervisor)).content).toEqual([{ type: "text", text: "modern" }]);
	const imported = importMcpConfiguration({
		mcpServers: {
			modern: { command: process.execPath, protocolVersion: "2026-07-28" },
			legacy: { command: process.execPath },
		},
	});
	expect(imported[0].protocolVersion).toBe("2026-07-28");
	expect(configurationSummary(imported[0]).protocolVersion).toBe("2026-07-28");
	expect(imported[1]).not.toHaveProperty("protocolVersion");
	expect(() => serverConfig.parse({ ...imported[0], protocolVersion: "unknown" })).toThrow();
});
it("pins modern-only HTTP connectors and closes their notification subscription", async () => {
	const handler = createMcpHandler(({ era }) => fixtureServer(era), { legacy: "reject" });
	const http = createServer(toNodeHandler(handler));
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		await handler.close();
		http.closeAllConnections();
		await new Promise<void>((resolve) => http.close(() => resolve()));
	});
	const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
	const { supervisor } = await runtime({ transport: "http", url, protocolVersion: "2026-07-28" });
	await supervisor.start("fixture");
	expect((await read(supervisor)).content).toEqual([{ type: "text", text: "modern" }]);
	await supervisor.shutdown();
});
it.each([false, true])(
	"terminates an actual legacy HTTP session after shutdown or failed discovery (failed=%s)",
	async (fail) => {
		let deletes = 0,
			initializations = 0;
		const transport = new NodeStreamableHTTPServerTransport({
			sessionIdGenerator: () => {
				initializations++;
				return randomUUID();
			},
		});
		const server = fixtureServer("legacy", fail);
		await server.connect(transport);
		const http = createServer((req, res) => {
			if (req.method === "DELETE") deletes++;
			void transport.handleRequest(req, res);
		});
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		cleanup.push(async () => {
			await server.close();
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		});
		const { supervisor } = await runtime({
			transport: "http",
			url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`,
		});
		if (fail) await expect(supervisor.start("fixture")).rejects.toThrow();
		else {
			await supervisor.start("fixture");
			expect((await read(supervisor)).content).toEqual([{ type: "text", text: "legacy" }]);
			await supervisor.shutdown();
		}
		expect(initializations).toBe(1);
		expect(deletes).toBe(1);
	},
);
