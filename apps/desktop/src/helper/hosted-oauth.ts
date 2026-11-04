import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import { auth, Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type {
	OAuthClientProvider,
	OAuthClientInformationMixed,
	OAuthTokens,
	Tool,
} from "@modelcontextprotocol/client";
import { OAuthTokensSchema } from "@modelcontextprotocol/core";
import { EncryptedStore } from "@repo/local-mcp-core/encrypted-store";
import { closeMcpConnection } from "@repo/local-mcp-core/mcp-lifecycle";
import { connectorOriginSchema } from "@repo/project-protocol/local-mcp";
import { z } from "zod";

import type { ClientSnapshot } from "../shared/helper-contracts";
import type { DesktopManager } from "./manager";

const oauthState = z
	.object({
		origin: connectorOriginSchema,
		desktopManagement: z.boolean().default(false),
		clientInformation: z.record(z.string(), z.unknown()).optional(),
		tokens: OAuthTokensSchema.optional(),
		verifier: z.string().optional(),
	})
	.strict();
type OAuthState = z.infer<typeof oauthState>;
type Connection = {
	status: ClientSnapshot["hosted"];
	error?: string;
	client?: Client;
	transport?: StreamableHTTPClientTransport;
	tools: Tool[];
	callback?: HttpServer;
	timeout?: ReturnType<typeof setTimeout>;
	pending?: Promise<void>;
	discovery?: Promise<void>;
	generation: number;
};

/** Credentials are scoped to one downstream registration and one hosted origin. */
export class HostedConnections {
	private connections = new Map<string, Connection>();
	private stores = new Map<string, EncryptedStore<OAuthState>>();
	constructor(
		private manager: DesktopManager,
		private openUrl: (url: string) => void,
	) {
		manager.hostedStatus = (id) => this.status(id);
	}
	private store(id: string) {
		let store = this.stores.get(id);
		if (!store) {
			const origin = this.manager.status().origin;
			store = new EncryptedStore(
				this.manager.root,
				`hosted-${id}-${createHash("sha256").update(origin).digest("hex").slice(0, 12)}`,
				oauthState,
				() => ({ origin, desktopManagement: false }),
				this.manager.entries,
			);
			this.stores.set(id, store);
		}
		return store;
	}
	status(id: string): Pick<ClientSnapshot, "hosted" | "error"> {
		const c = this.connections.get(id);
		return { hosted: c?.status ?? "disconnected", error: c?.error };
	}
	private connection(id: string) {
		let c = this.connections.get(id);
		if (!c) {
			c = { status: "disconnected", tools: [], generation: 0 };
			this.connections.set(id, c);
		}
		return c;
	}
	async restore() {
		await Promise.allSettled(
			this.manager
				.listClients()
				.filter((c) => c.enabled)
				.map(async (c) => {
					if ((await this.store(c.id).read()).tokens) await this.connect(c.id, false);
				}),
		);
	}
	async connect(id: string, interactive = true, desktopManagement?: boolean) {
		this.manager.client(id);
		const c = this.connection(id);
		if (
			desktopManagement !== undefined &&
			desktopManagement !== (await this.store(id).read()).desktopManagement
		) {
			await this.closeRuntime(c);
			++c.generation;
			await this.store(id).mutate((s) => {
				s.desktopManagement = desktopManagement;
				delete s.tokens;
				delete s.clientInformation;
			});
			c.status = "disconnected";
		}
		if (c.pending || c.status === "connected") return this.status(id);
		c.status = "connecting";
		c.error = undefined;
		this.manager.changed();
		c.pending = this.start(id, c, interactive)
			.catch(async () => {
				c.status = "needs-auth";
				c.error = "Hosted authorization failed or expired. Connect this AI client again.";
				await this.closeRuntime(c);
				this.manager.changed();
			})
			.finally(() => {
				c.pending = undefined;
			});
		await c.pending;
		return this.status(id);
	}
	private async start(id: string, c: Connection, interactive: boolean) {
		const generation = ++c.generation;
		const registration = this.manager.client(id),
			store = this.store(id);
		const state = await store.read(),
			origin = this.manager.status().origin;
		if (state.origin !== origin) throw new Error("OAuth origin mismatch");
		await this.closeRuntime(c);
		const stateCode = randomBytes(32).toString("base64url");
		let redirectUrl: URL;
		let redirected = false,
			callbackUsed = false,
			permitAuthorization = interactive;
		let stage = "authorization discovery";
		let httpFailure: number | undefined;
		const failure = () =>
			`Hosted authorization failed during ${stage}${httpFailure ? ` (HTTP ${httpFailure})` : ""}. Connect again.`;
		const expected = () => {
			this.manager.client(id);
			if (generation !== c.generation) throw new Error("Authorization cancelled");
		};
		const safeFetch: typeof fetch = async (input, init) => {
			const url = new URL(
				typeof input === "string" || input instanceof URL ? input.toString() : input.url,
			);
			if (url.origin !== origin || url.username || url.password)
				throw new Error("OAuth origin changed");
			const response = await fetch(input, { ...init, redirect: "error" });
			if (!response.ok) httpFailure = response.status;
			return response;
		};
		const provider: OAuthClientProvider = {
			get redirectUrl() {
				return redirectUrl;
			},
			get clientMetadata() {
				return {
					client_name: `Laplace Desktop · ${registration.name}`,
					redirect_uris: [redirectUrl.href],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: "none",
					scope: state.desktopManagement
						? "connections:use apps:write desktop:manage"
						: "connections:use apps:write",
				};
			},
			state: () => stateCode,
			clientInformation: async () =>
				(await store.read()).clientInformation as OAuthClientInformationMixed | undefined,
			saveClientInformation: async (value) => {
				expected();
				await store.mutate((s) => {
					s.clientInformation = value as unknown as Record<string, unknown>;
				});
			},
			tokens: async () => (await store.read()).tokens,
			saveTokens: async (value: OAuthTokens) => {
				expected();
				await store.mutate((s) => {
					s.tokens = value;
				});
			},
			saveCodeVerifier: async (value) => {
				await store.mutate((s) => {
					s.verifier = value;
				});
			},
			codeVerifier: async () => {
				const verifier = (await store.read()).verifier;
				if (!verifier) throw new Error("Missing PKCE verifier");
				return verifier;
			},
			redirectToAuthorization: async (url) => {
				expected();
				if (!permitAuthorization || url.origin !== origin)
					throw new Error("Interactive authorization required");
				redirected = true;
				// The SDK may prefer resource-advertised scopes over client metadata.
				// Consent must retain this registration's explicit management choice.
				url.searchParams.set("scope", provider.clientMetadata.scope!);
				this.openUrl(url.href);
			},
			invalidateCredentials: async (scope) => {
				await store.mutate((s) => {
					if (scope === "all" || scope === "tokens") delete s.tokens;
					if (scope === "all" || scope === "client") delete s.clientInformation;
					if (scope === "all" || scope === "verifier") delete s.verifier;
				});
			},
		};
		const connect = async () => {
			expected();
			stage = "MCP connection";
			httpFailure = undefined;
			const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
				authProvider: provider,
				fetch: safeFetch,
				requestInit: { redirect: "error" },
				reconnectionOptions: {
					maxRetries: 0,
					initialReconnectionDelay: 1000,
					maxReconnectionDelay: 1000,
					reconnectionDelayGrowFactor: 1,
				},
			});
			const client = new Client(
				{ name: `Laplace Desktop · ${registration.name}`, version: "0.1.0" },
				{ capabilities: {}, versionNegotiation: { mode: "legacy" } },
			);
			c.transport = transport;
			c.client = client;
			client.setNotificationHandler("notifications/tools/list_changed", async () => {
				if (c.client !== client || c.generation !== generation) return;
				try {
					await this.discover(c);
					if (c.client === client && c.generation === generation) c.error = undefined;
				} catch {
					if (c.client !== client || c.generation !== generation) return;
					c.tools = [];
					c.error = "Hosted catalog unavailable. Refresh tools to try again.";
				}
				if (c.client === client && c.generation === generation) this.manager.changed();
			});
			client.onclose = () => {
				if (c.client === client) {
					c.tools = [];
					c.status = "needs-auth";
					this.manager.changed();
				}
			};
			await client.connect(transport, { timeout: 30_000 });
			expected();
			stage = "tool discovery";
			httpFailure = undefined;
			await this.discover(c);
			c.status = "connected";
			c.error = undefined;
			permitAuthorization = false;
			this.closeCallback(c);
			this.manager.changed();
		};
		c.callback = createServer((request, response) => {
			const url = new URL(request.url ?? "/", redirectUrl);
			if (
				request.method !== "GET" ||
				request.headers.host !== redirectUrl.host ||
				request.headers.origin ||
				url.pathname !== "/callback" ||
				url.searchParams.get("state") !== stateCode ||
				url.searchParams.get("iss") !== origin ||
				callbackUsed
			) {
				response.writeHead(400).end("Invalid authorization callback.");
				return;
			}
			const code = url.searchParams.get("code");
			if (!code || code.length > 4096) {
				response.writeHead(400).end("Authorization was cancelled.");
				return;
			}
			callbackUsed = true;
			response
				.writeHead(200, {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "no-store",
					"Content-Security-Policy": "default-src 'none'",
				})
				.end("Authorization received. Return to Laplace Desktop.");
			void (async () => {
				try {
					expected();
					stage = "token exchange";
					httpFailure = undefined;
					const result = await auth(provider, {
						serverUrl: `${origin}/mcp`,
						authorizationCode: code,
						// Preserve the issuer already checked by the callback guard. The SDK
						// requires it when the server advertises RFC 9207 support.
						iss: url.searchParams.get("iss")!,
						scope: provider.clientMetadata.scope,
						fetchFn: safeFetch,
					});
					if (result !== "AUTHORIZED") throw new Error();
					await closeMcpConnection(c.client, c.transport);
					await connect();
					await store.mutate((s) => {
						delete s.verifier;
					});
				} catch {
					c.status = "needs-auth";
					c.error = failure();
					await this.closeRuntime(c);
					this.manager.changed();
				}
			})();
		});
		await new Promise<void>((resolve, reject) => {
			c.callback!.once("error", reject);
			c.callback!.listen(0, "127.0.0.1", resolve);
		});
		const address = c.callback.address();
		if (!address || typeof address === "string") throw new Error("Callback listener unavailable");
		redirectUrl = new URL(`http://127.0.0.1:${address.port}/callback`);
		c.timeout = setTimeout(() => {
			c.generation++;
			c.status = "needs-auth";
			c.error = "Hosted sign-in timed out. Connect again.";
			void this.closeRuntime(c);
			this.manager.changed();
		}, 300_000);
		c.timeout.unref();
		try {
			if (!state.tokens && interactive) {
				const result = await auth(provider, {
					serverUrl: `${origin}/mcp`,
					scope: provider.clientMetadata.scope,
					fetchFn: safeFetch,
				});
				if (result === "REDIRECT") {
					c.status = "connecting";
					this.manager.changed();
					return;
				}
			}
			await connect();
		} catch (error) {
			if (!redirected) throw error;
			c.status = "connecting";
			this.manager.changed();
		}
	}
	private async discover(c: Connection) {
		if (!c.client) throw new Error("Hosted connection unavailable");
		if (c.discovery) return c.discovery;
		const client = c.client;
		const generation = c.generation;
		const pending = this.readCatalog(client)
			.then((tools) => {
				if (c.client !== client || c.generation !== generation)
					throw new Error("Hosted connection changed during discovery");
				c.tools = tools;
			})
			.finally(() => {
				if (c.discovery === pending) c.discovery = undefined;
			});
		c.discovery = pending;
		return pending;
	}
	private async readCatalog(client: Client) {
		const tools: Tool[] = [],
			cursors = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor ? { cursor } : undefined, {
				timeout: 30_000,
				cacheMode: "refresh",
			});
			tools.push(...page.tools);
			cursor = page.nextCursor;
			if (tools.length > 1000 || (cursor && cursors.has(cursor)))
				throw new Error("Invalid hosted tool catalog");
			if (cursor) cursors.add(cursor);
		} while (cursor);
		if (new Set(tools.map((t) => t.name)).size !== tools.length)
			throw new Error("Duplicate hosted tools");
		return tools;
	}
	/** Public hosted MCP may not send list-change notifications. Recheck on downstream discovery. */
	async refreshTools(id: string) {
		this.manager.client(id);
		const c = this.connections.get(id);
		if (!c?.client || c.status !== "connected") return [];
		const client = c.client;
		const generation = c.generation;
		const before = JSON.stringify(c.tools);
		try {
			await this.discover(c);
			if (c.client !== client || c.generation !== generation) return this.tools(id);
			c.error = undefined;
		} catch {
			if (c.client !== client || c.generation !== generation) return this.tools(id);
			c.tools = [];
			c.error = "Hosted catalog unavailable. Refresh tools to try again.";
		}
		if (before !== JSON.stringify(c.tools)) this.manager.changed();
		return this.tools(id);
	}
	tools(id: string) {
		this.manager.client(id);
		const c = this.connections.get(id);
		return c?.status === "connected" ? c.tools : [];
	}
	async call(id: string, name: string, input: Record<string, unknown>, signal: AbortSignal) {
		this.manager.client(id);
		const c = this.connections.get(id);
		if (!c?.client || c.status !== "connected" || !c.tools.some((t) => t.name === name))
			throw new Error("Hosted tool unavailable; reconnect this AI client");
		try {
			return await c.client.callTool(
				{ name, arguments: input },
				{
					timeout: 180_000,
					signal,
				},
			);
		} catch {
			c.tools = [];
			c.status = "needs-auth";
			c.error = "Hosted call failed; its outcome may be unknown. It was not replayed.";
			this.manager.changed();
			throw new Error(c.error);
		}
	}
	private closeCallback(c: Connection) {
		if (c.timeout) clearTimeout(c.timeout);
		c.timeout = undefined;
		c.callback?.close();
		c.callback = undefined;
	}
	private async closeRuntime(c: Connection) {
		this.closeCallback(c);
		const client = c.client;
		c.client = undefined;
		c.discovery = undefined;
		c.tools = [];
		await closeMcpConnection(client, c.transport);
		c.transport = undefined;
	}
	async disconnect(id: string) {
		const c = this.connection(id);
		c.generation++;
		await this.closeRuntime(c);
		await this.store(id).mutate((s) => {
			delete s.tokens;
			delete s.verifier;
		});
		c.status = "disconnected";
		c.error = undefined;
		this.manager.changed();
		return this.status(id);
	}
	async shutdown() {
		await Promise.all(
			[...this.connections.values()].map(async (c) => {
				c.generation++;
				await this.closeRuntime(c);
				c.status = "disconnected";
			}),
		);
	}
}
