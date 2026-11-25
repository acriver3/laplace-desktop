import { Validator, type Schema } from "@cfworker/json-schema";
import { z } from "zod";

export const INIT = "LAPLACE_SESSION_INIT";
export const SEARCH = "LAPLACE_SEARCH";
export const MANAGE = "LAPLACE_MANAGE_CONNECTIONS";
export const EXECUTE = "LAPLACE_EXECUTOR";
export const PROXY = "LAPLACE_PROXY";
export const instructions =
	"Call LAPLACE_SESSION_INIT({}) first in each new chat and after a context reset. Keep the user's request in the conversation. Use the returned contextId once per subsequent call. Execute a known action directly or search with a focused query.";

const id = z.string().min(1).max(512);
const ref = z.string().min(1).max(4096);
const args = z.record(z.string(), z.unknown());
const target = { accountId: id.optional(), connectionName: id.optional() };
const page = {
	cursor: z
		.string()
		.regex(/^\d{1,8}$/)
		.optional(),
	limit: z.number().int().min(1).max(50).optional(),
};
const output = { fields: z.array(id).min(1).max(30).optional(), ...page };
const key = z.string().min(1).max(100).optional();
export const initInput = z.strictObject({
	contextId: ref.optional(),
	accountIds: z.array(id).min(1).max(50).optional(),
	connectionNames: z.array(id).min(1).max(50).optional(),
	...page,
});
export const searchItem = z
	.strictObject({
		...target,
		query: z.string().trim().min(1).max(200).optional(),
		actionId: id.optional(),
		provider: id.optional(),
		connected: z.boolean().optional(),
		...page,
	})
	.refine((x) => !!x.query !== !!x.actionId, "Supply one query or actionId.");
export const manageItem = z.strictObject({
	...target,
	operation: z.enum(["inspect", "connect", "reconnect", "status", "pause", "disconnect"]),
	arguments: args.default({}),
	idempotencyKey: key,
});
export const executeItem = z
	.strictObject({
		...target,
		actionId: id.optional(),
		actionRef: ref.optional(),
		arguments: args.default({}),
		idempotencyKey: key,
		...output,
	})
	.refine(
		(x) =>
			x.actionRef
				? !x.actionId && !x.connectionName && !x.accountId
				: !!x.actionId && !!x.connectionName,
		"Supply actionRef or actionId and connectionName.",
	);
export const proxyItem = z
	.strictObject({
		...target,
		actionRef: ref.optional(),
		method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
		path: z.string().min(1).max(1024).optional(),
		parameters: args.optional(),
		body: args.optional(),
		idempotencyKey: key,
		...output,
	})
	.refine(
		(x) =>
			x.actionRef
				? !x.method && !x.path && !x.connectionName && !x.accountId
				: !!x.method && !!x.path && !!x.connectionName,
		"Supply actionRef or method, path and connectionName.",
	);
export const batch = <T extends z.ZodType>(item: T) =>
	z.strictObject({ contextId: ref, items: z.array(item).min(1).max(10) });

function buildMetaTools(
	options: { manage?: boolean; proxy?: boolean; readOnly?: boolean; proxyWrites?: boolean } = {},
) {
	const tool = (name: string, description: string, schema: z.ZodType, readOnlyHint: boolean) => ({
		name,
		description,
		inputSchema: { ...z.toJSONSchema(schema, { io: "input" }), type: "object" as const },
		annotations: { readOnlyHint, destructiveHint: !readOnlyHint },
	});
	return [
		tool(INIT, instructions, initInput, true),
		tool(
			SEARCH,
			"Find connectors, actions and documented operations. Exact action IDs return the full input schema.",
			batch(searchItem),
			true,
		),
		...(options.manage
			? [
					tool(
						MANAGE,
						"Inspect connection setup or manage a connection. The user completes sign-in and consent.",
						batch(manageItem),
						false,
					),
				]
			: []),
		tool(
			EXECUTE,
			"Run one or more named actions. Supply a stable idempotencyKey for each write. Use another call for dependent inputs.",
			batch(executeItem),
			!!options.readOnly,
		),
		...(options.proxy
			? [
					tool(
						PROXY,
						"Call documented provider operations through an eligible connection. Write access is granted separately.",
						batch(proxyItem),
						!options.proxyWrites,
					),
				]
			: []),
	];
}
const catalogCache = new Map<string, ReturnType<typeof buildMetaTools>>();
export function metaTools(options: Parameters<typeof buildMetaTools>[0] = {}) {
	const key = [!!options.manage, !!options.proxy, !!options.readOnly, !!options.proxyWrites].join(
		",",
	);
	let catalog = catalogCache.get(key);
	if (!catalog) {
		catalog = buildMetaTools(options);
		catalogCache.set(key, catalog);
	}
	return catalog;
}
export function validateArguments(schema: unknown, input: unknown) {
	if (
		!schema ||
		typeof schema !== "object" ||
		!new Validator(schema as Schema).validate(input).valid
	)
		throw Error("INVALID_ACTION_ARGUMENTS");
}
export function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: v,
	);
}
export function pageOf<T>(rows: T[], options: { cursor?: string; limit?: number }) {
	const start = Number(options.cursor ?? 0),
		end = start + (options.limit ?? 20);
	return {
		items: rows.slice(start, end),
		complete: end >= rows.length,
		...(end < rows.length ? { nextCursor: String(end) } : {}),
	};
}
export type Status = "ok" | "failed" | "user_action_required" | "outcome_unknown" | "skipped";
export type Outcome = {
	status: Status;
	result?: unknown;
	receipt?: string;
	duplicate?: boolean;
	error?: string;
};
export type Prepared = {
	write: boolean;
	idempotencyKey?: string;
	identity: unknown;
	run: () => Promise<unknown>;
	authorize?: () => Promise<void>;
	admit?: () => Promise<void>;
	forward?: () => Promise<Outcome>;
};
export type ReceiptStore = {
	validate?(claims: { key: string; identity: string }[]): Promise<void>;
	claim(key: string, identity: string): Promise<{ receipt: string; previous?: Status }>;
	finish(receipt: string, status: Status): Promise<void>;
};
export function resultStatus(value: unknown): Status {
	if (!value || typeof value !== "object") return "ok";
	const row = value as Record<string, unknown>;
	const detail = row.structuredContent as Record<string, unknown> | undefined;
	const state = detail?.status ?? row.status;
	if (
		row.data &&
		typeof row.data === "object" &&
		("isError" in row.data || "structuredContent" in row.data)
	) {
		const nested = resultStatus(row.data);
		if (nested !== "ok") return nested;
	}
	if (state === "outcome_unknown") return "outcome_unknown";
	if (
		[
			"user_action_required",
			"approval_required",
			"pending_approval",
			"awaiting_approval",
			"pending",
			"requires_user_action",
			"awaiting_user",
			"processing",
			"initiated",
		].includes(String(state)) ||
		row.setupUrl ||
		row.authorizationUrl ||
		row.approvalUrl
	)
		return "user_action_required";
	if (
		row.isError ||
		row.ok === false ||
		row.success === false ||
		state === "failed" ||
		state === "expired"
	)
		return "failed";
	return "ok";
}
export async function validateBatch(items: Prepared[], receipts?: ReceiptStore) {
	const keys = new Set<string>();
	for (const item of items) {
		if (item.write && !item.idempotencyKey) throw Error("IDEMPOTENCY_KEY_REQUIRED");
		if (item.idempotencyKey && keys.has(item.idempotencyKey)) throw Error("DUPLICATE_BATCH_KEY");
		if (item.idempotencyKey) keys.add(item.idempotencyKey);
	}
	const claims = items
		.filter((x) => x.write && !x.forward)
		.map((x) => ({ key: x.idempotencyKey!, identity: canonical(x.identity) }));
	if (claims.length && items.length > 1) await receipts?.validate?.(claims);
}
export async function mapReads<T, R>(
	items: readonly T[],
	read: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await read(items[index]!, index);
			}
		}),
	);
	return results;
}
export async function runBatch(
	items: Prepared[],
	receipts: ReceiptStore,
): Promise<{ items: Outcome[] }> {
	await validateBatch(items, receipts);
	async function dispatch(item: Prepared): Promise<Outcome> {
		let receipt: string | undefined;
		let dispatched = false;
		try {
			await item.authorize?.();
			if (item.forward) {
				dispatched = true;
				return await item.forward();
			}
			if (item.write) {
				const claim = await receipts.claim(item.idempotencyKey!, canonical(item.identity));
				if (claim.previous)
					return { status: claim.previous, receipt: claim.receipt, duplicate: true };
				receipt = claim.receipt;
			}
			await item.admit?.();
			dispatched = true;
			const result = await item.run();
			const status = resultStatus(result);
			if (receipt) await receipts.finish(receipt, status);
			return { status, result, ...(receipt ? { receipt } : {}) };
		} catch (error) {
			const status =
				(receipt || (item.forward && item.write)) && dispatched ? "outcome_unknown" : "failed";
			if (receipt) await receipts.finish(receipt, status).catch(() => {});
			return {
				status,
				...(receipt ? { receipt } : {}),
				error: error instanceof Error ? error.message : "OPERATION_FAILED",
			};
		}
	}
	const outcomes: Outcome[] = [];
	if (items.some((x) => x.write)) {
		for (const item of items)
			outcomes.push(
				outcomes.length && outcomes[outcomes.length - 1]!.status !== "ok"
					? { status: "skipped" }
					: await dispatch(item),
			);
	} else {
		return { items: await mapReads(items, dispatch) };
	}
	return { items: outcomes };
}

/** Preserve upstream cursors even when projecting fields from a local page. */
export function presentRead(
	value: unknown,
	options: { fields?: string[]; cursor?: string; limit?: number },
) {
	const object = (v: unknown): v is Record<string, unknown> =>
		!!v && typeof v === "object" && !Array.isArray(v);
	if (
		object(value) &&
		(value.isError ||
			value._meta ||
			(value.content &&
				(!value.structuredContent || !(options.fields || options.cursor || options.limit))))
	)
		return value;
	const payload = object(value)
		? (value.structuredContent ?? value.data ?? value.output ?? value)
		: value;
	const listKeys = [
		"items",
		"results",
		"tasks",
		"projects",
		"sections",
		"comments",
		"labels",
		"messages",
		"records",
		"entries",
	];
	const collection = object(payload)
		? Object.entries(payload).find(([k, v]) => listKeys.includes(k) && Array.isArray(v))
		: undefined;
	const rows = Array.isArray(payload) ? payload : (collection?.[1] as unknown[] | undefined);
	const project = (v: unknown) =>
		options.fields && object(v)
			? Object.fromEntries(
					options.fields
						.filter((k) => Object.prototype.hasOwnProperty.call(v, k))
						.map((k) => [k, v[k]]),
				)
			: v;
	const continuation = object(payload) ? (payload.next_cursor ?? payload.nextCursor) : undefined;
	if (!rows)
		return {
			data: project(payload),
			complete: !continuation,
			...(continuation ? { providerCursor: continuation } : {}),
		};
	const page = pageOf(rows, options);
	return {
		...page,
		items: page.items.map(project),
		complete: page.complete && !continuation,
		...(collection ? { collection: collection[0] } : {}),
		...(continuation ? { providerCursor: continuation } : {}),
	};
}

/** MCP reserves _meta for the host. Approval capabilities must never enter model text. */
export function v2McpResult(payload: Record<string, unknown>) {
	const host: Record<string, unknown> = Object.create(null);
	function collect(value: unknown) {
		if (
			value &&
			typeof value === "object" &&
			"_meta" in value &&
			value._meta &&
			typeof value._meta === "object"
		)
			Object.assign(host, value._meta);
	}
	collect(payload);
	if (Array.isArray(payload.items))
		for (const item of payload.items) {
			if (!item || typeof item !== "object" || !("status" in item)) continue;
			collect(item);
			const result = item.result;
			if (
				result &&
				typeof result === "object" &&
				("content" in result || "structuredContent" in result)
			)
				collect(result);
		}
	function visible(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(visible);
		if (!value || typeof value !== "object") return value;
		const { _meta, ...rest } = value as Record<string, unknown>;

		return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, visible(v)]));
	}
	const structuredContent = visible(payload) as Record<string, unknown>;
	return {
		content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
		structuredContent,
		...(Object.keys(host).length ? { _meta: host } : {}),
	};
}
