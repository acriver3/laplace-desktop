import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, isAbsolute } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { minimalEnvironment } from "@repo/local-mcp-core/config";
import { systemEntry } from "@repo/local-mcp-core/store";
import { z } from "zod";

import { desktopVersion } from "./shared/version";
import { updateLaunchBlocked, UpdateError } from "./update-guard";
import { BridgeConnection } from "./bridge-connection";
import { bridgeConnectionMessage, bridgeCallMessage } from "./bridge-errors";

const descriptorSchema = z
	.object({
		version: z.literal(1),
		pid: z.number().int().positive(),
		endpoint: z
			.string()
			.url()
			.refine((value) => {
				const u = new URL(value);
				return (
					u.protocol === "http:" &&
					u.hostname === "127.0.0.1" &&
					u.pathname === "/mcp" &&
					!u.username &&
					!u.password &&
					!u.search &&
					!u.hash
				);
			}),
	})
	.strict();
function option(name: string, fallback?: string) {
	const index = process.argv.indexOf(name);
	return index < 0 ? fallback : process.argv[index + 1];
}
async function discover(root: string) {
	try {
		const descriptor = descriptorSchema.parse(
			JSON.parse(await readFile(join(root, "endpoint.json"), "utf8")),
		);
		process.kill(descriptor.pid, 0);
		return descriptor.endpoint;
	} catch {
		return undefined;
	}
}
async function endpoint(root: string) {
	let value = await discover(root);
	if (value) return value;
	try {
		const launcher = z
			.object({
				executable: z.string().refine(isAbsolute),
				args: z.array(z.string().max(4096)).max(20),
			})
			.strict()
			.parse(JSON.parse(await readFile(join(root, "launcher.json"), "utf8")));
		if (await updateLaunchBlocked(launcher.executable))
			throw new UpdateError(
				"install",
				"Laplace is installing an update. Reconnect after it finishes restarting.",
			);
		const child = spawn(launcher.executable, launcher.args, {
			detached: true,
			stdio: "ignore",
			shell: false,
			windowsHide: true,
			env: minimalEnvironment(homedir(), { LAPLACE_DESKTOP_ROOT: root }),
		});
		child.on("error", () => {});
		child.unref();
	} catch (error) {
		if (error instanceof UpdateError) throw error;
		throw new Error("Open Laplace Desktop, then restart this MCP connection.");
	}
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		value = await discover(root);
		if (value) return value;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error("Laplace Desktop did not become available. Open the app and review its status.");
}
export async function runBridge() {
	const root = resolve(option("--root", join(homedir(), ".laplace-desktop"))!);
	const clientId = z.string().uuid().parse(option("--client-id"));
	const token = (await systemEntry(root, `client:${clientId}`)).getPassword();
	if (!token)
		throw new Error("This AI client is not registered. Connect it again in Laplace Desktop.");
	let closed = false;
	let front: Server | undefined;
	const connection = new BridgeConnection(
		async () => {
			const client = new Client(
				{ name: "Laplace Desktop bridge", version: desktopVersion },
				{ capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
			);
			const transport = new StreamableHTTPClientTransport(new URL(await endpoint(root)), {
				requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
				reconnectionOptions: {
					maxRetries: 0,
					initialReconnectionDelay: 1000,
					maxReconnectionDelay: 1000,
					reconnectionDelayGrowFactor: 1,
				},
			});
			client.setNotificationHandler("notifications/tools/list_changed", async () => {
				if (!closed) await front?.sendToolListChanged().catch(() => {});
			});
			let closeLink: Promise<void> | undefined;
			const release = () => (closeLink ??= client.close().catch(() => {}));
			try {
				await client.connect(transport, { timeout: 30_000 });
				const subscription = await client.listen({ toolsListChanged: true }, { timeout: 30_000 });
				await client.listTools(undefined, { timeout: 30_000 });
				return { client, closed: subscription.closed, close: release };
			} catch (error) {
				await release();
				throw error;
			}
		},
		() => {
			void front?.sendToolListChanged().catch(() => {});
		},
	);
	const wire = new StdioServerTransport();
	const stdio = serveStdio(
		() => {
			const server = new Server(
				{ name: "Laplace Desktop", version: desktopVersion },
				{ capabilities: { tools: { listChanged: true }, resources: {} } },
			);
			front = server;
			server.onclose = () => {
				if (front === server) front = undefined;
			};
			server.setRequestHandler("tools/list", async (request) => {
				try {
					return await (await connection.ready()).listTools(request.params, { timeout: 30_000 });
				} catch (error) {
					throw new Error(bridgeConnectionMessage(error));
				}
			});
			server.setRequestHandler("resources/list", async (request) =>
				(await connection.ready()).listResources(request.params, { timeout: 30_000 }),
			);
			server.setRequestHandler("resources/read", async (request) =>
				(await connection.ready()).readResource(request.params, { timeout: 30_000 }),
			);
			server.setRequestHandler("tools/call", async (request, ctx) => {
				let started = false;
				try {
					const upstream = await connection.ready();
					ctx.mcpReq.signal.throwIfAborted();
					started = true;
					return await upstream.callTool(request.params, {
						signal: ctx.mcpReq.signal,
						timeout: 185_000,
					});
				} catch (error) {
					return {
						isError: true,
						content: [{ type: "text", text: bridgeCallMessage(error, started) }],
					};
				}
			});
			return server;
		},
		{ legacy: "serve", maxSubscriptions: 1, transport: wire },
	);
	const close = async () => {
		if (closed) return;
		closed = true;
		clearInterval(parentWatch);
		await connection.close();
		await stdio.close().catch(() => {});
		process.stdin.destroy();
	};
	const parent = process.ppid;
	const parentWatch = setInterval(() => {
		try {
			process.kill(parent, 0);
			if (process.ppid !== parent) void close();
		} catch {
			void close();
		}
	}, 1000);
	parentWatch.unref();
	process.once("SIGTERM", () => void close());
	process.once("SIGINT", () => void close());
	process.stdin.once("end", () => void close());
	const wireClosed = wire.onclose;
	wire.onclose = () => {
		wireClosed?.();
		void close();
	};
}
if (process.argv[1]?.endsWith("bridge.cjs") || process.argv[1]?.endsWith("bridge.ts"))
	void runBridge().catch((error) => {
		process.stderr.write(
			`${error instanceof z.ZodError ? "Invalid Laplace Desktop bridge configuration." : error instanceof Error ? error.message : "Laplace Desktop bridge failed."}\n`,
		);
		process.exitCode = 1;
	});
