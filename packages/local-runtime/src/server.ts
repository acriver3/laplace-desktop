import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import { ToolSchema } from "@modelcontextprotocol/core";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Server, createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { Tool } from "@modelcontextprotocol/server";
import {
	brokerTools,
	brokerToolInput,
	checkBrokerTool,
	brokerMcpResult,
	BROKER_UI_URI,
} from "@repo/project-protocol/credential-broker";
import { localCredentialTool } from "@repo/project-protocol/credentials";
import { brokerApprovalResource } from "@repo/project-protocol/mcp/broker-approval-resource";
import { browserApprovalResource } from "@repo/project-protocol/mcp/browser-approval-resource";
import { ToolCatalog, type CatalogEntry } from "@repo/project-protocol/mcp/catalog";
import {
	isLocalConnectorToolName,
	laplaceDiscoveryTools,
	discoverySetupSchema,
	localBootstrapTools,
} from "@repo/project-protocol/mcp/local-tools";
import { ycUiResource } from "@repo/project-protocol/mcp/yc-resource";
import { ycUiTools, YC_UI_URI } from "@repo/project-protocol/mcp/yc-schema";
import { z } from "zod";

import {
	ConnectorManagement,
	connectorManagementTools,
	isConnectorManagementTool,
} from "./connector-tools";
import type { CredentialBroker, CredentialPrincipal } from "./credentials";
import { desktopManagementTool, manageDesktop, type DesktopSection } from "./desktop-tools";
import type { Discovery } from "./discovery";
import type { HostedConnections } from "./hosted-oauth";
import type { DesktopManager } from "./manager";
import { BROWSER_APPROVAL_URI } from "./shared/browser-approval";
import { credentialBrokeringEnabled } from "./shared/credential-broker-feature";
import { desktopVersion } from "./shared/version";
import { desktopYcView, ycConnections, ycInvocationTools } from "./yc-ui";

const MAX_BODY = 1_048_576;
export const CONTROL_PATH = "/control/v1/";
/** Management channel for Desktop and the CLI; never offered to AI clients or web content. */
export type ControlServer = {
	token: string;
	protocol: number;
	request(method: string, input: unknown): Promise<unknown>;
	subscribe(listener: (event: unknown) => void): () => void;
};
const digest = (value: string) => createHash("sha256").update(value).digest();
type Exchange = {
	clientId: string;
	controller: AbortController;
	subscription: boolean;
	protocol: string;
};
type Call = {
	clientId: string;
	controller: AbortController;
	name: string;
	executor: string;
	localTools?: string[];
};
/** Authenticated local MCP exposes connector execution and bounded setup operations. */
export async function startMcpServer(
	manager: DesktopManager,
	hosted: Pick<HostedConnections, "tools" | "call"> &
		Partial<Pick<HostedConnections, "refreshTools" | "status" | "connect" | "disconnect">>,
	credentials?: CredentialBroker,
	connectors?: ConnectorManagement,
	openDesktop?: (section: DesktopSection) => void,
	control?: ControlServer,
	discovery?: Discovery,
) {
	const principal = (clientId: string): CredentialPrincipal => ({
		id: `local:${clientId}`,
		name: manager.client(clientId).name,
		hosted: false,
		authorize: () => {
			manager.client(clientId);
			if (!manager.clientToolAllowed(clientId, "local_credentials"))
				throw new Error("Credential tool disabled for this client");
		},
	});
	const catalog = (clientId: string) => {
		manager.client(clientId);
		// Hosted Laplace serves its own laplace_status/laplace_setup; the runtime's versions
		// already report hosted state, so they replace the hosted copies instead of conflicting.
		const hostedTools = hosted
			.tools(clientId)
			.filter((tool) => !laplaceDiscoveryTools.some((local) => local.name === tool.name));
		if (
			hostedTools.some(
				(tool) =>
					tool.name === desktopManagementTool.name ||
					isLocalConnectorToolName(tool.name) ||
					isConnectorManagementTool(tool.name),
			)
		)
			throw new Error("Conflicting tool catalog entries: reserved local connector namespace");
		const entries: CatalogEntry<Tool>[] = [
			{
				id: "desktop:manage",
				tool: desktopManagementTool,
				route: { executor: "desktop", target: desktopManagementTool.name },
				available:
					!!hosted.status &&
					!!hosted.connect &&
					!!hosted.disconnect &&
					!!openDesktop &&
					manager.clientToolAllowed(clientId, desktopManagementTool.name),
			},
			...brokerTools(true).map((tool) => ({
				id: "broker:" + tool.name,
				tool: ToolSchema.parse(tool),
				route: { executor: "broker", target: tool.name },
				available:
					credentialBrokeringEnabled() &&
					!!credentials &&
					manager.clientToolAllowed(clientId, "local_credentials") &&
					manager.clientToolAllowed(clientId, "local_connectors_manage"),
			})),
			...laplaceDiscoveryTools.map((tool) => ({
				id: `laplace:${tool.name}`,
				tool: ToolSchema.parse(tool),
				route: { executor: "laplace", target: tool.name },
				available: !!discovery,
			})),
			// Compatibility names from the standalone CLI, served by the shared runtime.
			...localBootstrapTools
				.filter((tool) => ["laplace_local_status", "laplace_local_setup"].includes(tool.name))
				.map((tool) => ({
					id: `laplace:${tool.name}`,
					tool: ToolSchema.parse({
						...tool,
						inputSchema: { type: "object", additionalProperties: true },
					}),
					route: { executor: "laplace", target: tool.name },
					available: !!discovery,
				})),
			...ycUiTools.map((tool) => ({
				id: `yc-ui:${tool.name}`,
				tool: ToolSchema.parse(tool),
				route: { executor: "yc-ui", target: tool.name },
				available: ycConnections(manager, clientId).length > 0,
			})),
			...connectorManagementTools.map((tool) => ({
				id: `setup:${tool.name}`,
				tool,
				route: { executor: "setup", target: tool.name },
				available: !!connectors && connectors.canCall(clientId, tool.name),
			})),
			{
				id: "credentials:local",
				tool: ToolSchema.parse(localCredentialTool),
				route: { executor: "credentials", target: localCredentialTool.name },
				requirements: { connections: ["desktop"] },
				available: !!credentials && manager.clientToolAllowed(clientId, localCredentialTool.name),
			},
			...manager.tools().map((tool) => ({
				id: `connector:${tool.name}`,
				tool: { ...tool, _meta: { ...tool._meta, ui: { visibility: ["model"] } } },
				route: { executor: "local", target: tool.name },
				available: manager.clientToolAllowed(clientId, tool.name),
			})),
			...hostedTools.map((tool) => ({
				id: `hosted:${tool.name}`,
				tool,
				route: { executor: "hosted", target: tool.name },
			})),
		];
		return new ToolCatalog({ connection: "desktop", transport: "http" }, entries);
	};

	const exchanges = new Map<string, Exchange>();
	const calls = new Map<string, Call>();
	const events: Array<{ at: string; reason: string }> = [];
	const record = (reason: string) => {
		events.push({ at: new Date().toISOString(), reason });
		if (events.length > 50) events.shift();
	};
	let endpoint = "";
	let closing = false;
	const handler = createMcpHandler(
		({ authInfo, era }) => {
			const clientId = authInfo!.clientId;
			manager.client(clientId);
			const server = new Server(
				{ name: "Laplace Desktop", version: desktopVersion },
				{ capabilities: { tools: { listChanged: era === "modern" }, resources: {} } },
			);
			server.setRequestHandler("resources/list", async () => ({
				resources: [
					...(credentialBrokeringEnabled() && credentials?.allowed(principal(clientId))
						? [
								{
									uri: BROKER_UI_URI,
									name: "Credential review",
									mimeType: "text/html;profile=mcp-app",
								},
							]
						: []),
					...(connectors?.browserApprovals &&
					connectors.canCall(clientId, "local_connectors_browser_show")
						? [
								{
									uri: BROWSER_APPROVAL_URI,
									name: "Browser connection approval",
									mimeType: "text/html;profile=mcp-app",
								},
							]
						: []),
					...(ycConnections(manager, clientId).length
						? [
								{
									uri: YC_UI_URI,
									name: "YC application editor",
									mimeType: "text/html;profile=mcp-app",
								},
							]
						: []),
				],
			}));
			server.setRequestHandler("resources/read", async (request) => {
				if (
					request.params.uri === BROKER_UI_URI &&
					credentialBrokeringEnabled() &&
					credentials?.allowed(principal(clientId))
				)
					return { contents: [brokerApprovalResource()] };
				if (
					request.params.uri === BROWSER_APPROVAL_URI &&
					connectors?.browserApprovals &&
					connectors.canCall(clientId, "local_connectors_browser_show")
				)
					return { contents: [browserApprovalResource()] };
				if (request.params.uri !== YC_UI_URI || !ycConnections(manager, clientId).length)
					throw Error("Resource unavailable.");
				return { contents: [ycUiResource("https://apply.ycombinator.com")] };
			});
			server.setRequestHandler("tools/list", async () => {
				await manager.refresh();
				await hosted.refreshTools?.(clientId);
				return { tools: catalog(clientId).tools() };
			});
			server.setRequestHandler("tools/call", async (request, ctx) => {
				if (
					manager.supervisor.maintenanceActive ||
					manager.updateMaintenance?.() ||
					calls.size >= 128 ||
					[...calls.values()].filter((call) => call.clientId === clientId).length >= 32
				) {
					record("busy");
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Laplace Desktop is busy. This tool call was not started. Try again after running calls finish.",
							},
						],
						_meta: { "com.laplace/dispatch": "not_started" },
					};
				}
				const invocationId = randomUUID();
				const controller = new AbortController(),
					abort = () => controller.abort();
				ctx.mcpReq.signal.addEventListener("abort", abort, { once: true });
				if (ctx.mcpReq.signal.aborted) abort();
				try {
					const currentCatalog = catalog(clientId);
					const entry = currentCatalog.resolve(request.params.name);
					const input = z.record(z.string(), z.unknown()).parse(request.params.arguments ?? {});
					calls.set(invocationId, {
						clientId,
						controller,
						name: entry.tool.name,
						executor: entry.route.executor,
						localTools:
							entry.route.executor === "yc-ui"
								? ycInvocationTools(manager, clientId, input)
								: undefined,
					});
					return await currentCatalog.dispatch<Awaited<ReturnType<DesktopManager["callNamed"]>>>(
						request.params.name,
						input,
						{
							desktop: async (_route, args) => {
								try {
									const result = await manageDesktop(
										manager,
										hosted as HostedConnections,
										clientId,
										args,
										openDesktop!,
									);
									return {
										content: [{ type: "text" as const, text: JSON.stringify(result) }],
										structuredContent: result,
									};
								} catch {
									return {
										isError: true,
										content: [
											{
												type: "text" as const,
												text: "Desktop operation failed. Inspect status and permissions before retrying. No operation was automatically replayed.",
											},
										],
									};
								}
							},
							broker: async (route, args) => {
								const input = brokerToolInput.parse(args);
								checkBrokerTool(route.target, input);
								if (!credentials!.connectionBroker && !credentials!.allowed(principal(clientId))) {
									return brokerMcpResult(
										await credentials!.call(principal(clientId), {
											action: "status",
											requestId: input.requestId,
										}),
										input,
										route.target,
									);
								}

								const result = await credentials!.call(
									principal(clientId),
									input.poll
										? { action: "result", requestId: input.requestId }
										: { action: "broker", requestId: input.requestId, command: input.command },
								);
								return brokerMcpResult(result, input, route.target);
							},
							laplace: async (route, args) => {
								const result =
									route.target === "laplace_setup"
										? await discovery!.setup(clientId, discoverySetupSchema.parse(args).target)
										: route.target === "laplace_local_setup"
											? await discovery!.setup(clientId, "browser")
											: await discovery!.status(clientId);
								return {
									content: [{ type: "text" as const, text: JSON.stringify(result) }],
									structuredContent: result as Record<string, unknown>,
								};
							},
							"yc-ui": async (route, args) => {
								const view = await desktopYcView(
									manager,
									clientId,
									route.target,
									args,
									controller.signal,
								);
								return {
									content: [{ type: "text" as const, text: JSON.stringify(view) }],
									structuredContent: view,
								};
							},
							setup: async (route, args) => {
								try {
									return await connectors!.call(clientId, route.target, args);
								} catch {
									return {
										isError: true,
										content: [
											{
												type: "text",
												text: "Connector setup request failed. Check the tool schema, catalog fields, existing connector/job status, and client permissions. Existing IDs are never replaced. Review Desktop diagnostics if needed; secret values are not returned.",
											},
										],
									};
								}
							},
							credentials: async (_route, args) => {
								try {
									if (
										args.action === "broker" ||
										credentials!.isBrokerRequest(principal(clientId), String(args.requestId))
									)
										throw Error("Use the broker tool.");
									const result = await credentials!.call(principal(clientId), args);
									return { content: [{ type: "text", text: JSON.stringify(result) }] };
								} catch {
									return {
										isError: true,
										content: [
											{
												type: "text",
												text: "Credential request unavailable. Review Bitwarden settings and client access in Laplace Desktop.",
											},
										],
									};
								}
							},
							local: (route, args) =>
								manager.callNamed(route.target, args, controller.signal, clientId),
							hosted: (route, args) => hosted.call(clientId, route.target, args, controller.signal),
						},
						controller.signal,
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Tool call failed";
					return { isError: true, content: [{ type: "text", text: message }] };
				} finally {
					calls.delete(invocationId);
					if (controller.signal.aborted) record("call_cancelled");
					ctx.mcpReq.signal.removeEventListener("abort", abort);
				}
			});

			return server;
		},
		{ legacy: "stateless", maxRequestBodySize: MAX_BODY, maxSubscriptions: 256 },
	);
	const http = createServer((request, response) => {
		void handle(request, response).catch(() => {
			record("invalid_request");
			if (!response.headersSent)
				response.writeHead(400, { "Cache-Control": "no-store" }).end("Invalid MCP request");
			else response.end();
		});
	});
	http.requestTimeout = 190_000;
	http.headersTimeout = 10_000;
	http.maxHeadersCount = 32;
	async function handleControl(
		control: ControlServer,
		request: IncomingMessage,
		response: ServerResponse,
	) {
		const authorization = request.headers.authorization ?? "";
		if (
			!authorization.startsWith("Bearer ") ||
			authorization.length > 200 ||
			!timingSafeEqual(digest(authorization.slice(7)), digest(control.token))
		) {
			response.writeHead(401).end();
			return;
		}
		if (request.headers["laplace-runtime-protocol"] !== String(control.protocol)) {
			response
				.writeHead(409, { "Content-Type": "application/json" })
				.end(JSON.stringify({ error: "protocol", protocol: control.protocol }));
			return;
		}
		if (closing) {
			response.writeHead(503).end();
			return;
		}
		const path = request.url!.slice(CONTROL_PATH.length);
		if (path === "events" && request.method === "GET") {
			response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
			const unsubscribe = control.subscribe((event) =>
				response.write(`data: ${JSON.stringify(event)}\n\n`),
			);
			response.once("close", unsubscribe);
			return;
		}
		if (path !== "request" || request.method !== "POST") {
			response.writeHead(404).end();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > MAX_BODY) {
				response.writeHead(413).end();
				return;
			}
			chunks.push(chunk);
		}
		const body = z
			.object({ method: z.string().min(1).max(100), input: z.unknown().default({}) })
			.strict()
			.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		if (!body.success) {
			response.writeHead(400).end();
			return;
		}
		const reply = await control.request(body.data.method, body.data.input);
		response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
	}
	async function handle(request: IncomingMessage & { auth?: AuthInfo }, response: ServerResponse) {
		response.setHeader("Cache-Control", "no-store");
		if (request.headers.host !== new URL(endpoint).host || request.headers.origin) {
			response.writeHead(403).end();
			return;
		}
		if (control && request.url?.startsWith(CONTROL_PATH)) {
			await handleControl(control, request, response);
			return;
		}
		if (request.url !== "/mcp") {
			response.writeHead(403).end();
			return;
		}
		const authorization = request.headers.authorization ?? "";
		const client =
			authorization.startsWith("Bearer ") && authorization.length < 200
				? manager.authenticateClient(authorization.slice(7))
				: undefined;
		if (!client) {
			response.writeHead(401).end();
			return;
		}
		if (closing) {
			response.writeHead(503).end();
			return;
		}
		request.auth = { token: "", clientId: client.id, scopes: [] };
		const id = randomUUID(),
			controller = new AbortController();
		const exchange: Exchange = {
			clientId: client.id,
			controller,
			subscription: false,
			protocol: "legacy",
		};
		exchanges.set(id, exchange);
		const finish = () => {
			if (!exchanges.delete(id)) return;
			controller.abort();
			record(response.writableFinished ? "completed" : "disconnected");
			response.removeListener("close", finish);
			response.removeListener("finish", finish);
		};
		response.once("close", finish);
		response.once("finish", finish);
		const serve = toNodeHandler(
			{
				fetch: async (web, options) => {
					// Diagnostics use a bounded method/version label, never request arguments.
					if (web.method === "POST") {
						const message = await web
							.clone()
							.json()
							.catch(() => null);
						exchange.subscription = message?.method === "subscriptions/listen";
						if (
							message?.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28"
						)
							exchange.protocol = "2026-07-28";
					}
					return handler.fetch(
						new Request(web, { signal: AbortSignal.any([web.signal, controller.signal]) }),
						options,
					);
				},
			},
			{ maxRequestBodySize: MAX_BODY, onerror: () => record("transport_error") },
		);
		try {
			await serve(request, response);
		} finally {
			if (response.destroyed || response.writableFinished) finish();
		}
	}
	await new Promise<void>((resolve, reject) => {
		http.once("error", reject);
		http.listen(0, "127.0.0.1", resolve);
	});
	const address = http.address();
	if (!address || typeof address === "string") throw new Error("MCP endpoint unavailable");
	endpoint = `http://127.0.0.1:${address.port}/mcp`;
	manager.endpoint = endpoint;
	await mkdir(manager.root, { recursive: true, mode: 0o700 });
	const descriptor = join(manager.root, "endpoint.json"),
		temporary = `${descriptor}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify({ version: 1, endpoint, pid: process.pid }), {
		mode: 0o600,
	});
	await rename(temporary, descriptor);

	const unsubscribe = manager.onChanged(() => {
		connectors?.permissionsChanged();
		for (const exchange of exchanges.values()) {
			try {
				manager.client(exchange.clientId);
			} catch {
				credentials?.revokePrincipal(`local:${exchange.clientId}`);
				exchange.controller.abort();
				record("registration_revoked");
			}
		}
		for (const call of calls.values()) {
			if (!manager.clientToolAllowed(call.clientId, "local_credentials"))
				credentials?.revokePrincipal(`local:${call.clientId}`);
			try {
				manager.client(call.clientId);
				if (
					call.executor !== "hosted" &&
					call.executor !== "yc-ui" &&
					!manager.clientToolAllowed(call.clientId, call.name)
				)
					call.controller.abort();
				if (
					call.executor === "yc-ui" &&
					(!ycConnections(manager, call.clientId).length ||
						call.localTools?.some((name) => !manager.clientToolAllowed(call.clientId, name)))
				)
					call.controller.abort();
			} catch {
				call.controller.abort();
			}
		}
		handler.notify.toolsChanged();
	});
	manager.changed();
	const diagnostics = () => ({
		activeCalls: calls.size,
		subscriptions: [...exchanges.values()].filter((e) => e.subscription).length,
		activeRequests: exchanges.size,
		protocols: [...new Set([...exchanges.values()].map((e) => e.protocol))],
		events: [...events],
	});
	manager.mcpDiagnostics = diagnostics;
	return {
		endpoint,
		sessionCount: () => 0,
		diagnostics,
		async close() {
			closing = true;
			record("shutdown");
			unsubscribe();
			for (const exchange of exchanges.values()) exchange.controller.abort();
			for (const call of calls.values()) call.controller.abort();
			await handler.close();
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
			await rm(descriptor, { force: true });
			manager.endpoint = undefined;
		},
	};
}
