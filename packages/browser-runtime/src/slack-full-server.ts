import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ToolSchema } from "@modelcontextprotocol/core";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { browserTransferLimit } from "./browser-transfer";
import { SlackFullBrowserRelay, slackFullActions } from "./slack-full-relay";
import { ycSetupNames } from "./yc-browser";

const execute = promisify(execFile);
const writeTools: Record<string, string[]> = {
	conversations_add_message: ["chat.postMessage", "conversations.mark"],
	reactions_add: ["reactions.add"],
	reactions_remove: ["reactions.remove"],
	conversations_mark: ["conversations.mark"],
	conversations_leave: ["conversations.leave"],
	conversations_join: ["conversations.join"],
	usergroups_create: ["usergroups.create"],
	usergroups_update: ["usergroups.update"],
	usergroups_users_update: ["usergroups.users.update"],
	usergroups_me: ["usergroups.users.update"],
	saved_update: ["saved.update"],
	saved_clear_completed: ["saved.clearCompleted"],
};
const safeEqual = (a: string, b: string) =>
	a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function slackChildEnvironment(source: NodeJS.ProcessEnv) {
	return Object.fromEntries(
		Object.entries(source).filter(
			([key, value]) =>
				value !== undefined &&
				!/^SLACK_MCP_XOX/.test(key) &&
				![
					"LAPLACE_BROWSER_ENDPOINT",
					"LAPLACE_BROWSER_CAPABILITY",
					"SLACK_MCP_USERS_CACHE",
					"SLACK_MCP_CHANNELS_CACHE",
				].includes(key),
		),
	) as Record<string, string>;
}

/** The existing Go handlers keep the public contract. Their HTTP client can only
 * invoke registered browser operations through this per-child loopback bridge. */
export class SlackBrowserChild {
	private client?: Client;
	private transport?: StdioClientTransport;
	private directory?: string;
	private revision?: string;
	private capability = "";
	private endpoint = "";
	private active?: { name: string; signal: AbortSignal; revision: string };
	private stopping?: Promise<void>;
	private watch?: ReturnType<typeof setInterval>;
	private bridge = createServer((request, response) => {
		void (async () => {
			response.setHeader("Cache-Control", "no-store");
			if (
				request.headers.host !== new URL(this.endpoint).host ||
				request.headers.origin ||
				request.method !== "POST" ||
				request.url !== "/execute" ||
				request.headers["content-type"] !== "application/json" ||
				!this.capability ||
				!safeEqual(request.headers.authorization ?? "", `Bearer ${this.capability}`)
			) {
				response.writeHead(403).end();
				return;
			}
			const invocation = this.active;
			const revision = this.revision;
			if (!revision || revision !== this.relay.connectionRevision())
				throw Error("Browser approval ended.");
			const parts: Buffer[] = [];
			let size = 0;
			for await (const part of request) {
				size += part.length;
				if (size > browserTransferLimit) throw Error("Browser request too large.");
				parts.push(Buffer.from(part));
			}
			const { method, args } = z
				.object({ method: z.string(), args: z.unknown() })
				.strict()
				.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
			if (!Object.hasOwn(slackFullActions, method)) throw Error("Unregistered Slack operation.");
			const action = slackFullActions[method]!;
			if (
				"write" in action &&
				action.write &&
				(!invocation ||
					invocation.signal.aborted ||
					invocation.revision !== revision ||
					!(
						writeTools[invocation.name]?.includes(method.slice(4)) ||
						method === "api.conversations.view"
					))
			)
				throw Error("This invocation does not permit the Slack write.");
			const abort = new AbortController();
			const cancel = () => abort.abort();
			request.once("aborted", cancel);
			response.once("close", cancel);
			invocation?.signal.addEventListener("abort", cancel, { once: true });
			try {
				const result = await this.relay.read(method, args, abort.signal);
				if (revision !== this.relay.connectionRevision()) throw Error("Browser account changed.");
				response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
			} finally {
				invocation?.signal.removeEventListener("abort", cancel);
				request.removeListener("aborted", cancel);
				response.removeListener("close", cancel);
			}
		})().catch(() => {
			if (!response.writableEnded)
				response.writeHead(502).end("Browser operation interrupted; outcome may be uncertain.");
		});
	});
	constructor(
		private relay: SlackFullBrowserRelay,
		private binary: string,
		private environment = process.env,
	) {}
	async catalog() {
		const { stdout } = await execute(this.binary, ["--catalog-json"], {
			env: slackChildEnvironment(this.environment),
			timeout: 30_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		return z.array(ToolSchema).parse(JSON.parse(stdout));
	}
	async listen() {
		await new Promise<void>((resolve, reject) => {
			this.bridge.once("error", reject);
			this.bridge.listen(0, "127.0.0.1", () => resolve());
		});
		const address = this.bridge.address();
		if (!address || typeof address === "string") throw Error("Local bridge unavailable.");
		this.endpoint = `http://127.0.0.1:${address.port}/execute`;
		this.watch = setInterval(() => {
			if (this.revision && this.revision !== this.relay.connectionRevision()) void this.stop();
		}, 500);
		this.watch.unref();
	}
	private async start(signal: AbortSignal) {
		await this.stopping;
		const revision = this.relay.connectionRevision();
		if (!revision || signal.aborted)
			throw Error("Approve the selected Slack account before using its tools.");
		if (this.client && this.revision === revision) return this.client;
		await this.stop();
		this.revision = revision;
		this.capability = randomBytes(32).toString("base64url");
		this.directory = await mkdtemp(join(tmpdir(), "laplace-slack-"));
		const environment = slackChildEnvironment(this.environment);
		this.transport = new StdioClientTransport({
			command: this.binary,
			args: ["--transport", "stdio"],
			stderr: "pipe",
			env: {
				...environment,
				LAPLACE_TETHERED_BROWSER_V1: "true",
				LAPLACE_BROWSER_ENDPOINT: this.endpoint,
				LAPLACE_BROWSER_CAPABILITY: this.capability,
				SLACK_MCP_USERS_CACHE: join(this.directory, "users.json"),
				SLACK_MCP_CHANNELS_CACHE: join(this.directory, "channels.json"),
			},
		});
		// Go diagnostics may contain message text; keep them out of the agent's transport.
		this.transport.stderr?.on("data", () => {});
		const client = new Client(
			{ name: "laplace-slack-browser", version: "0.1.0" },
			{ capabilities: {}, versionNegotiation: { mode: "legacy" } },
		);
		this.client = client;
		try {
			await client.connect(this.transport, { timeout: 180_000, signal });
			if (revision !== this.relay.connectionRevision())
				throw Error("Browser approval changed during initialization.");
			return client;
		} catch (error) {
			await this.stop();
			throw error;
		}
	}
	async call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
		if (this.active)
			throw Error("Slack is busy. Wait for the current operation; do not replay writes.");
		// Capture the entire invocation, including name-resolution reads and writes.
		const revision = this.relay.connectionRevision();
		if (!revision) throw Error("Slack browser approval required.");
		this.active = { name, signal, revision };
		try {
			const client = await this.start(signal);
			const result = await client.callTool({ name, arguments: args }, { timeout: 180_000, signal });
			if (revision !== this.relay.connectionRevision()) throw Error("Browser account changed.");
			return result;
		} catch {
			await this.stop();
			throw Error(
				"SAVE_UNVERIFIED: Slack operation interrupted. Check its outcome before retrying; it was not replayed.",
			);
		} finally {
			this.active = undefined;
		}
	}
	async readResource(uri: string, signal: AbortSignal) {
		if (this.active) throw Error("Slack is busy.");
		const revision = this.relay.connectionRevision();
		if (!revision) throw Error("Slack browser approval required.");
		this.active = { name: "resource.read", signal, revision };
		try {
			const client = await this.start(signal);
			const result = await client.readResource({ uri }, { timeout: 180_000, signal });
			if (revision !== this.relay.connectionRevision()) throw Error("Browser account changed.");
			return result;
		} finally {
			this.active = undefined;
		}
	}
	stop() {
		if (this.stopping) return this.stopping;
		const client = this.client,
			transport = this.transport,
			directory = this.directory;
		this.client = undefined;
		this.transport = undefined;
		this.directory = undefined;
		this.capability = "";
		this.revision = undefined;
		this.stopping = (async () => {
			await client?.close().catch(() => {});
			await transport?.close().catch(() => {});
			if (directory) await rm(directory, { recursive: true, force: true });
		})().finally(() => {
			this.stopping = undefined;
		});
		return this.stopping;
	}
	async close() {
		clearInterval(this.watch);
		await this.stop();
		this.bridge.closeAllConnections();
		await new Promise<void>((resolve) => this.bridge.close(() => resolve()));
	}
}

export async function runSlackBrowser(binary: string) {
	if (process.env.LAPLACE_TETHERED_BROWSER_V1 !== "true")
		throw Error("Tethered Slack is not enabled.");
	const relay = new SlackFullBrowserRelay(process.env.LAPLACE_BROWSER_WORKSPACE ?? "");
	const child = new SlackBrowserChild(relay, binary);
	const tools = await child.catalog();
	const known = new Set(tools.map((tool) => tool.name));
	await relay.listen();
	await child.listen();
	const server = new Server(
		{ name: "Slack [Tethered]", version: "1.2.0-candidate.1" },
		{ capabilities: { tools: {}, resources: {} } },
	);
	const workspace = new URL(relay.workspace).hostname.split(".")[0];
	const resources = [
		{
			uri: `slack://${workspace}/channels`,
			name: "Directory of Slack channels",
			description: "This resource provides a directory of Slack channels.",
			mimeType: "text/csv",
		},
		{
			uri: `slack://${workspace}/users`,
			name: "Directory of Slack users",
			description: "This resource provides a directory of Slack users.",
			mimeType: "text/csv",
		},
	];
	server.setRequestHandler("resources/list", async () => ({ resources }));
	server.setRequestHandler("resources/read", async (request, ctx) => {
		if (!resources.some((resource) => resource.uri === request.params.uri))
			throw Error("Unknown Slack resource.");
		return child.readResource(request.params.uri, ctx.mcpReq.signal);
	});
	server.setRequestHandler("tools/list", async () => ({
		tools: [
			...tools,
			...[...ycSetupNames, "laplace_slack_verify"].map((name) => ({
				name,
				description: "Internal Laplace browser setup.",
				inputSchema: {
					type: "object" as const,
					properties: {},
					additionalProperties: ["laplace_browser_authorize", "laplace_browser_focus"].includes(
						name,
					),
				},
			})),
		],
	}));
	server.setRequestHandler("tools/call", async (request, ctx) => {
		try {
			const { name, arguments: args = {} } = request.params;
			if (known.has(name)) return await child.call(name, args, ctx.mcpReq.signal);
			let result: unknown;
			if (name === "laplace_browser_authorize") result = relay.authorize(args);
			else if (name === "laplace_browser_focus") result = relay.focus(args);
			else {
				z.object({}).strict().parse(args);
				if (name === "laplace_browser_review") result = relay.review();
				else if (name === "laplace_browser_status") result = relay.status();
				else if (name === "laplace_browser_pair") {
					await child.stop();
					result = relay.pairing();
				} else if (name === "laplace_browser_revoke") {
					result = relay.revoke();
					await child.stop();
				} else if (name === "laplace_slack_verify")
					result = await relay.read("api.auth.test", { params: {} }, ctx.mcpReq.signal);
				else throw Error("Unknown Slack tool.");
			}
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: error instanceof Error ? error.message : "Slack operation failed.",
					},
				],
			};
		}
	});
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		await child.close();
		await relay.close();
		await server.close();
	};
	process.stdin.once("end", () => void close());
	process.once("SIGINT", () => void close());
	process.once("SIGTERM", () => void close());
	await server.connect(new StdioServerTransport());
}
