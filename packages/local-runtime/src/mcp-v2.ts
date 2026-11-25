import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Tool } from "@modelcontextprotocol/server";
import { scopedToolName } from "@repo/project-protocol/local-mcp";
import type { ToolCatalog } from "@repo/project-protocol/mcp/catalog";
import {
	v2McpResult,
	batch,
	initInput,
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
	INIT,
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
	const token = sessionTokens(secret, [client, transport]);
	const ctxSchema = z.object({ session: z.string(), upstream: z.string().optional() });
	let ctx: { session: string; upstream?: string };
	if (name === INIT && !Object.keys(input).length) ctx = { session: randomUUID() };
	else {
		try {
			ctx = ctxSchema.parse(token.open(String(input.contextId)));
		} catch {
			throw Error("SESSION_INIT_REQUIRED");
		}
	}
	const localToken = sessionTokens(secret, [client, transport, ctx.session]);
	const current = catalog();
	if (!desktopMetaTools(current).some((t) => t.name === name)) throw Error("TOOL_UNAVAILABLE");
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
	const upstreamAvailable = current.tools().some((t) => t.name === INIT);
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
	if (name === INIT) {
		const options = initInput.parse(input);
		const { contextId: _old, ...filters } = options;
		let hosted: Record<string, unknown> | undefined;
		if (
			upstreamAvailable &&
			(!filters.accountIds || filters.accountIds.some((id) => id !== "desktop"))
		) {
			const remote = {
				...filters,
				...(filters.accountIds
					? { accountIds: filters.accountIds.filter((id) => id !== "desktop") }
					: {}),
			};
			hosted = await upstream(INIT, ctx.upstream ? { ...remote, contextId: ctx.upstream } : {});
			ctx.upstream = z.string().parse(hosted.contextId);
		}
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
			if (
				(filters.accountIds && !filters.accountIds.includes("desktop")) ||
				(filters.connectionNames && !filters.connectionNames.includes(row.connectionName))
			)
				continue;
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
		if (hosted) {
			const { contextId: _up, ...summary } = hosted;
			hosted = summary;
		}
		return envelope({
			contextId: token.action(ctx),
			accounts:
				!filters.accountIds || filters.accountIds.includes("desktop")
					? [{ accountId: "desktop", name: "Laplace Desktop" }]
					: [],
			connections: pageOf([...groups.values()], filters),
			...(hosted ? { hosted } : {}),
			setup: "Open Laplace Desktop to connect a service.",
		});
	}
	if (name === SEARCH) {
		const { items } = batch(searchItem).parse(input);
		const remoteQueries = items
			.map((q, i) => ({ q, i }))
			.filter(
				({ q }) =>
					ctx.upstream && q.accountId !== "desktop" && !q.connectionName?.startsWith("desktop"),
			);
		const remote = remoteQueries.length
			? z.array(z.unknown()).parse(
					(
						await upstream(SEARCH, {
							contextId: ctx.upstream,
							items: remoteQueries.map((r) => r.q),
						})
					).items,
				)
			: [];
		return envelope({
			items: items.map((q, i) => {
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
				const r = remoteQueries.findIndex((r) => r.i === i);
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
	const isLocal = (x: (typeof items)[number]) =>
		x.accountId === "desktop" ||
		x.connectionName === "desktop" ||
		x.connectionName?.startsWith("desktop:") ||
		("actionRef" in x && x.actionRef?.startsWith("local.")) ||
		(name === MANAGE && !x.accountId && !x.connectionName && !ctx.upstream);
	if (items.every((x) => !isLocal(x))) {
		if (!ctx.upstream) throw Error("CONNECTION_UNAVAILABLE");
		return envelope(await upstream(name, { contextId: ctx.upstream, items }));
	}
	const remoteItems = items.filter((x) => !isLocal(x));
	const preflight =
		remoteItems.length && ctx.upstream
			? z
					.array(z.object({ write: z.boolean() }))
					.parse(
						(await upstream(name, { contextId: ctx.upstream, items: remoteItems }, true)).items,
					)
			: [];
	if (remoteItems.length !== preflight.length) throw Error("CONNECTION_UNAVAILABLE");
	const prepared: Prepared[] = items.map((x) => {
		if (!isLocal(x)) {
			const index = remoteItems.indexOf(x);
			const forward = async (): Promise<Outcome> => {
				const value = await upstream(name, { contextId: ctx.upstream, items: [x] });
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
