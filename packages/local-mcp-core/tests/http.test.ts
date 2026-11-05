import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { serverConfig } from "../src/config";
import { Supervisor } from "../src/supervisor";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});
async function fixture(drop = false) {
	let calls = 0;
	const authorizations: Array<string | undefined> = [];
	const server = createServer(async (request, response) => {
		if (request.method === "GET") {
			response.writeHead(405).end();
			return;
		}
		if (request.method === "DELETE") {
			response.writeHead(200).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const message = JSON.parse(body);
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		let result: unknown;
		if (message.method === "initialize")
			result = {
				protocolVersion: message.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "loopback-fixture", version: "1" },
			};
		else if (message.method === "tools/list")
			result = {
				tools: [{ name: "write", inputSchema: { type: "object", additionalProperties: false } }],
			};
		else {
			calls++;
			authorizations.push(request.headers.authorization);
			if (drop) {
				response.destroy();
				return;
			}
			result = { content: [{ type: "text", text: "synthetic" }] };
		}
		response
			.writeHead(200, { "Content-Type": "application/json" })
			.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
	const root = await mkdtemp(join(tmpdir(), "laplace-http-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const supervisor = new Supervisor(
		root,
		root,
		() => {},
		async () => {},
		async () => {},
	);
	cleanup.push(() => supervisor.shutdown());
	supervisor.configure([
		serverConfig.parse({
			id: "http",
			name: "Loopback",
			transport: "http",
			url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
			headers: { Authorization: "Bearer synthetic-local-credential" },
		}),
	]);
	await supervisor.start("http");
	const invocation = {
		localId: "http",
		revision: supervisor.states()[0]!.revision!,
		tool: "write",
		input: {},
	};
	return { supervisor, invocation, calls: () => calls, authorizations };
}
it("initializes and invokes explicitly configured Streamable HTTP with local-only credential headers", async () => {
	const f = await fixture();
	const result = await f.supervisor.call(f.invocation, Date.now() + 1000, new AbortController());
	expect(result.content).toEqual([{ type: "text", text: "synthetic" }]);
	expect(f.authorizations).toEqual(["Bearer synthetic-local-credential"]);
});
it("does not resend a write after its HTTP response disappears", async () => {
	const f = await fixture(true);
	await expect(
		f.supervisor.call(f.invocation, Date.now() + 1000, new AbortController()),
	).rejects.toThrow();
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(f.calls()).toBe(1);
});
