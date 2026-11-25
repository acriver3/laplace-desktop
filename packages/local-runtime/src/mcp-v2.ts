import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Tool } from "@modelcontextprotocol/server";
import { scopedToolName } from "@repo/project-protocol/local-mcp";
import type { ToolCatalog } from "@repo/project-protocol/mcp/catalog";
import {
	handshakeInstructions,
	summarizeConnections,
	type connectionSummary,
	v2McpResult,
	batch,
	searchItem,
	manageItem,
	executeItem,
	proxyItem,
	metaTools,
	canonical,
	pageOf,
	presentRead,
	runBatch,
	validateArguments,
	SEARCH,
	MANAGE,
	EXECUTE,
	PROXY,
	type Prepared,
	type ReceiptStore,
	type Status,
	type Outcome,
} from "@repo/project-protocol/mcp/interface-v2";
import { schemaVersion, sessionTokens } from "@repo/project-protocol/mcp/v2-tokens";
import { z } from "zod";

import type { DesktopManager } from "./manager";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function receipts(root: string, client: string): ReceiptStore {
	const dir = join(root, "mcp-write-receipts", digest(client));
	return {
		async validate(claims) {
			await Promise.all(
				claims.map(async (c) => {
					let hash: string;
					try {
						hash = await readFile(join(dir, digest(c.key)), "utf8");
					} catch (e) {
						if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
						throw e;
					}
					if (hash !== digest(c.identity)) throw Error("IDEMPOTENCY_KEY_CONFLICT");
				}),
			);
		},
		async claim(key, value) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const receipt = digest(key),
				file = join(dir, receipt),
				fingerprint = digest(value);
			try {
				await writeFile(file, fingerprint, { flag: "wx", mode: 0o600, flush: true });
				return { receipt };
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}
			if ((await readFile(file, "utf8")) !== fingerprint) throw Error("IDEMPOTENCY_KEY_CONFLICT");
			let previous: Status = "outcome_unknown";
			try {
				previous = z
					.enum(["ok", "failed", "outcome_unknown", "user_action_required"])
					.parse(await readFile(file + ".outcome", "utf8"));
			} catch {
				/* Interrupted writes retain the original claim. */
			}
			return { receipt, previous };
		},
		async finish(receipt, status) {
			await writeFile(join(dir, receipt + ".outcome"), status, { mode: 0o600, flush: true });
		},
	};
}
export function appOnly(tool: Tool) {
	const ui = tool._meta?.ui as { visibility?: string[] } | undefined;
	return !!ui?.visibility && !ui.visibility.includes("model");
}
export function desktopMetaTools(catalog: ToolCatalog<Tool>) {
	const list = catalog.tools();
	return metaTools({
		manage: list.some(
			(t) =>
				t.name === "local_desktop_manage" ||
				t.name === "local_connectors_manage" ||
				t.name === MANAGE,
		),
		proxy: list.some((t) => t.name === PROXY),
		proxyWrites: list.some((t) => t.name === PROXY && !t.annotations?.readOnlyHint),
	});
}
type Call = (
	name: string,
	args: Record<string, unknown>,
	validateOnly?: boolean,
) => Promise<unknown>;
const hostedResult = z
	.object({
		isError: z.boolean().optional(),
		structuredContent: z.record(z.string(), z.unknown()).optional(),
		content: z.array(z.object({ text: z.string().optional() }).passthrough()).optional(),
	})
	.passthrough();
function publishedActions(manager: DesktopManager, current: ToolCatalog<Tool>) {
	const native = new Map(
		manager.supervisor.states().flatMap((s) =>
			s.tools.map(
				(t) =>
					[
						scopedToolName(s.id, t.name, digest),
						{
							accountId: "desktop",
							connectionName: "desktop:" + s.id,
							label: s.name,
							provider: s.id,
							actionId: t.name,
							status: s.status,
						},
					] as const,
			),
		),
	);
	const upstreamAvailable = current
		.tools()
		.some((t) => t.name === SEARCH && current.resolve(t.name).route.executor === "hosted");
	const legacyHosted = (t: Tool) =>
		!upstreamAvailable && current.resolve(t.name).route.executor === "hosted";
	const published = current
		.tools()
		.filter(
			(t) =>
				!appOnly(t) && (legacyHosted(t) || current.resolve(t.name).route.executor !== "hosted"),
		)
		.map((t) => ({
			tool: t,
			readOnly:
				current.resolve(t.name).route.executor !== "local" &&
				t.annotations?.readOnlyHint === true &&
				(!legacyHosted(t) ||
					["list_accounts", "list_connections", "search_actions", "get_action_guide"].includes(
						t.name,
					)),
			...(native.get(t.name) ??
				(legacyHosted(t)
					? {
							accountId: "desktop",
							connectionName: "desktop:hosted-v1",
							label: "Laplace hosted (v1)",
							provider: "laplace",
							actionId: t.name,
							status: "connected",
						}
					: {
							accountId: "desktop",
							connectionName: "desktop",
							label: "Laplace Desktop",
							provider: "laplace",
							actionId: t.name,
							status: "ready",
						})),
		}));
	return { published, upstreamAvailable };
}
function localInventory(
	published: ReturnType<typeof publishedActions>["published"],
	q: z.infer<typeof searchItem>,
) {
	const groups = new Map<
		string,
		{
			accountId: string;
			connectionName: string;
			label: string;
			service: string;
			status: string;
			exampleActions: string[];
		}
	>();
	for (const row of published) {
		const g = groups.get(row.connectionName) ?? {
			accountId: "desktop",
			connectionName: row.connectionName,
			label: row.label,
			service: row.provider,
			status: row.status,
			exampleActions: [],
		};
		if (g.exampleActions.length < 3) g.exampleActions.push(row.actionId);
		groups.set(row.connectionName, g);
	}
	return [...groups.values()]
		.filter(
			(c) =>
				(!q.accountId || q.accountId === c.accountId) &&
				(!q.provider || c.service === q.provider) &&
				(!q.connectionName || c.connectionName === q.connectionName),
		)
		.sort((a, b) => a.connectionName.localeCompare(b.connectionName));
}

export async function desktopHandshake(
	manager: DesktopManager,
	catalog: ToolCatalog<Tool>,
	preview: () => Promise<z.infer<typeof connectionSummary> | undefined>,
) {
	const { published, upstreamAvailable } = publishedActions(manager, catalog);
	const local = localInventory(published, { accountId: "desktop" });
	const hosted =
		upstreamAvailable && local.length < 6 ? await preview().catch(() => undefined) : undefined;
	return handshakeInstructions(
		summarizeConnections(
			[...local, ...(hosted?.connections ?? [])],
			!upstreamAvailable || hosted?.complete === true,
		),
	);
}

export async function desktopV2(
	manager: DesktopManager,
	client: string,
	secret: string,
	transport: string,
	catalog: () => ToolCatalog<Tool>,
	call: Call,
	name: string,
	input: Record<string, unknown>,
) {
	const localToken = sessionTokens(secret, [client, transport]);
	const current = catalog();
	if (!desktopMetaTools(current).some((t) => t.name === name)) throw Error("TOOL_UNAVAILABLE");
	const { published, upstreamAvailable } = publishedActions(manager, current);
	async function upstream(
		tool: string,
		args: Record<string, unknown>,
		validateOnly = false,
	): Promise<Record<string, unknown>> {
		const result = hostedResult.parse(await call(tool, args, validateOnly));
		if (result.isError || !result.structuredContent)
			throw Error(result.content?.[0]?.text ?? "HOSTED_CALL_FAILED");
		return { ...result.structuredContent, ...(result._meta ? { _meta: result._meta } : {}) };
	}
	const envelope = v2McpResult;
	if (name === SEARCH) {
		const { items } = batch(searchItem).parse(input);
		const remoteQueries = items.flatMap((q, i) => {
			if (
				!upstreamAvailable ||
				q.accountId === "desktop" ||
				(!q.accountId &&
					(q.connectionName === "desktop" || q.connectionName?.startsWith("desktop:")))
			)
				return [];
			if (q.mode !== "connections") return [{ q, i }];
			const count = localInventory(published, q).length,
				start = Number(q.cursor ?? 0),
				limit = q.limit ?? 20;
			const localCount = Math.min(limit, Math.max(0, count - start));
			return [
				{
					i,
					q: {
						...q,
						cursor: String(Math.max(0, start - count)),
						limit: Math.max(1, limit - localCount),
					},
				},
			];
		});
		const remote = remoteQueries.length
			? z.array(z.unknown()).parse(
					(
						await upstream(SEARCH, {
							items: remoteQueries.map((r) => r.q),
						})
					).items,
				)
			: [];
		return envelope({
			items: items.map((q, i) => {
				const r = remoteQueries.findIndex((r) => r.i === i);
				if (q.mode === "connections") {
					const local = localInventory(published, q),
						limit = q.limit ?? 20,
						start = Number(q.cursor ?? 0);
					const rows = local.slice(start, start + limit);
					const remoteResult =
						r < 0
							? undefined
							: z
									.object({
										status: z.literal("ok"),
										result: z.object({
											accounts: z.array(z.unknown()),
											connections: z.object({ items: z.array(z.unknown()), complete: z.boolean() }),
											setup: z.object({ url: z.string() }).optional(),
										}),
									})
									.safeParse(remote[r]);
					if (remoteResult && !remoteResult.success)
						return { status: "failed", error: "HOSTED_INVENTORY_UNAVAILABLE" };
					const extra = remoteResult?.data?.result;
					const remaining = limit - rows.length;
					const complete =
						start + limit >= local.length &&
						(!extra || (extra.connections.complete && extra.connections.items.length <= remaining));
					return {
						status: "ok",
						result: {
							accounts: [
								...(!q.accountId || q.accountId === "desktop"
									? [
											{
												accountId: "desktop",
												name: "Laplace Desktop",
												freshness: "runtime_snapshot",
												observedAt: new Date().toISOString(),
											},
										]
									: []),
								...(extra?.accounts ?? []),
							],
							connections: {
								items: [...rows, ...(extra?.connections.items.slice(0, remaining) ?? [])],
								complete,
								...(complete ? {} : { nextCursor: String(start + limit) }),
							},
							setup: {
								desktop: "Open Laplace Desktop to connect a service.",
								...(extra?.setup ? { url: extra.setup.url } : {}),
							},
						},
					};
				}
				const found = published.filter(
					(p) =>
						(!q.accountId || q.accountId === p.accountId) &&
						(!q.provider || q.provider === p.provider) &&
						(!q.connectionName || p.connectionName === q.connectionName) &&
						q.connected !== false &&
						(q.actionId
							? p.actionId === q.actionId
							: (p.actionId + " " + (p.tool.description ?? ""))
									.toLowerCase()
									.includes(q.query!.toLowerCase())),
				);
				const page = pageOf(found, { ...q, limit: q.limit ?? 5 });
				const entries = page.items.map((p) => ({
					accountId: p.accountId,
					provider: p.provider,
					connectionName: p.connectionName,
					actionId: p.actionId,
					availability: "available",
					nextTool: EXECUTE,
					effect: p.readOnly ? "read" : "write",
					description: p.tool.description,
					...(q.actionId
						? { inputSchema: p.tool.inputSchema }
						: { inputs: Object.keys(p.tool.inputSchema.properties ?? {}) }),
					actionRef:
						"local." +
						localToken.action({
							name: p.tool.name,
							version: schemaVersion([p.connectionName, p.tool.inputSchema, p.readOnly]),
						}),
				}));
				return {
					status: "ok",
					result: { ...page, items: entries, ...(r >= 0 ? { hosted: remote[r] } : {}) },
				};
			}),
		});
	}
	const items =
		name === MANAGE
			? batch(manageItem).parse(input).items
			: name === PROXY
				? batch(proxyItem).parse(input).items
				: batch(executeItem).parse(input).items;
	// Resolve omitted targets against both catalogs before dispatching any item.
	if (name === EXECUTE) {
		for (const [index, x] of items.entries()) {
			if (!("actionId" in x) || !x.actionId || x.connectionName) continue;
			const local = published.filter(
				(p) => p.actionId === x.actionId && (!x.accountId || x.accountId === p.accountId),
			);
			if (!local.length) continue;
			let remote: { accountId: string; connectionName: string }[] = [],
				more = false;
			if (upstreamAvailable && x.accountId !== "desktop") {
				const hit = await upstream(SEARCH, {
					items: [
						{
							actionId: x.actionId,
							connected: true,
							...(x.accountId ? { accountId: x.accountId } : {}),
						},
					],
				});
				const page = z
					.object({
						items: z
							.array(
								z.object({
									result: z.object({
										items: z.array(z.object({ accountId: z.string(), connectionName: z.string() })),
										complete: z.boolean(),
									}),
								}),
							)
							.length(1),
					})
					.parse(hit).items[0]!.result;
				remote = page.items;
				more = !page.complete;
			}
			const choices = [
				...local.map(({ accountId, connectionName }) => ({ accountId, connectionName })),
				...remote,
			];
			if (choices.length !== 1 || more)
				return envelope({
					items: items.map((_, i) =>
						i === index
							? {
									status: "user_action_required",
									error: "AMBIGUOUS_CONNECTION",
									choices: choices.slice(0, 10),
									complete: !more && choices.length <= 10,
									nextTool: SEARCH,
								}
							: { status: "skipped" },
					),
				});
			x.connectionName = local[0]!.connectionName;
			x.accountId = "desktop";
		}
	}
	const isLocal = (x: (typeof items)[number]) =>
		x.accountId === "desktop" ||
		(!x.accountId &&
			(x.connectionName === "desktop" || x.connectionName?.startsWith("desktop:"))) ||
		("actionRef" in x && x.actionRef?.startsWith("local.")) ||
		(name === MANAGE && !x.accountId && !x.connectionName && !upstreamAvailable);
	if (items.every((x) => !isLocal(x))) {
		if (!upstreamAvailable) throw Error("CONNECTION_UNAVAILABLE");
		return envelope(await upstream(name, { items }));
	}
	const remoteItems = items.filter((x) => !isLocal(x));
	const checked =
		remoteItems.length && upstreamAvailable
			? await upstream(name, { items: remoteItems }, true)
			: undefined;
	if (
		checked &&
		Array.isArray(checked.items) &&
		checked.items.some((x) => x?.error === "AMBIGUOUS_CONNECTION")
	)
		return envelope({
			items: items.map((x) =>
				isLocal(x) ? { status: "skipped" } : (checked.items as unknown[])[remoteItems.indexOf(x)],
			),
		});
	const preflight = checked ? z.array(z.object({ write: z.boolean() })).parse(checked.items) : [];
	if (remoteItems.length !== preflight.length) throw Error("CONNECTION_UNAVAILABLE");
	const prepared: Prepared[] = items.map((x) => {
		if (!isLocal(x)) {
			const index = remoteItems.indexOf(x);
			const forward = async (): Promise<Outcome> => {
				const value = await upstream(name, { items: [x] });
				const result = z
					.object({
						status: z.enum(["ok", "failed", "user_action_required", "outcome_unknown", "skipped"]),
					})
					.passthrough()
					.parse(z.array(z.unknown()).length(1).parse(value.items)[0]);
				return { ...result, ...(value._meta ? { _meta: value._meta } : {}) };
			};
			return {
				write: preflight[index]!.write,
				idempotencyKey: x.idempotencyKey,
				identity: x,
				run: forward,
				forward,
			};
		}
		let target: string, args: Record<string, unknown>, write: boolean;
		if ("operation" in x) {
			if (x.accountId && x.accountId !== "desktop") throw Error("ACCOUNT_UNAVAILABLE");
			const id = x.connectionName?.startsWith("desktop:") ? x.connectionName.slice(8) : undefined;
			target = "local_desktop_manage";
			if (id && !published.some((p) => p.connectionName === x.connectionName))
				throw Error("CONNECTION_UNAVAILABLE");
			if (id) {
				if (x.operation === "reconnect") {
					target = "local_connectors_authenticate";
					args = { ...x.arguments, id };
					write = true;
				} else if (x.operation === "inspect" || x.operation === "status") {
					target = "local_connectors_status";
					args = { ...x.arguments, id };
					write = false;
				} else if (x.operation === "pause") {
					args = { ...x.arguments, action: "stop", id };
					write = true;
				} else throw Error("MANAGEMENT_OPERATION_UNSUPPORTED");
			} else if (x.operation === "connect" && x.arguments.catalogId) {
				target = "local_connectors_install";
				args = { ...x.arguments, idempotencyKey: x.idempotencyKey };
				write = true;
			} else if (x.operation === "status" && x.arguments.jobId) {
				target = "local_connectors_status";
				args = x.arguments;
				write = false;
			} else {
				if (x.operation === "pause") throw Error("CONNECTION_REQUIRED");
				const op =
					x.operation === "connect" || x.operation === "reconnect"
						? "authorize"
						: x.operation === "disconnect"
							? "disconnect"
							: "status";
				args = { ...x.arguments, action: op };
				write = op !== "status";
			}
		} else if ("arguments" in x) {
			const ref = x.actionRef
				? z
						.object({ name: z.string(), version: z.string() })
						.parse(localToken.open(x.actionRef.slice(6)))
				: undefined;
			const p = published.find((p) =>
				ref
					? p.tool.name === ref.name
					: p.connectionName === x.connectionName &&
						p.actionId === x.actionId &&
						(!x.accountId || x.accountId === p.accountId),
			);
			if (
				!p ||
				(ref && ref.version !== schemaVersion([p.connectionName, p.tool.inputSchema, p.readOnly]))
			)
				throw Error("ACTION_UNAVAILABLE");
			target = p.tool.name;
			args = x.arguments;
			write = !p.readOnly;
		} else throw Error("PROXY_UNAVAILABLE");
		validateArguments(current.resolve(target).tool.inputSchema, args);
		return {
			write,
			idempotencyKey: x.idempotencyKey,
			identity: [target, args],
			authorize: async () => {
				manager.client(client);
				catalog().resolve(target);
			},
			run: async () => {
				const result = await call(target, args);
				if (write || !("fields" in x || "cursor" in x || "limit" in x)) return result;
				const mcp = hostedResult.parse(result);
				return mcp.isError || mcp._meta ? result : presentRead(mcp.structuredContent ?? result, x);
			},
		};
	});
	return envelope(await runBatch(prepared, receipts(manager.root, client)));
}
