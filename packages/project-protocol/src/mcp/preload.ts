import { z } from "zod";

import { batch, EXECUTE, PROXY, searchItem } from "./interface-v2";

export const preloadKey = "com.laplace/preload";
const matchBudgetBytes = 16_000;
const requestSchema = batch(
	z
		.strictObject({
			query: searchItem.shape.query,
			actionId: searchItem.shape.actionId,
			accountId: searchItem.shape.accountId,
			connectionName: searchItem.shape.connectionName,
			provider: searchItem.shape.provider,
		})
		.refine((q) => Boolean(q.query) !== Boolean(q.actionId)),
);
export type PreloadItem = z.infer<typeof requestSchema>["items"][number] & { connected: true };
const matchSchema = z.object({
	actionId: z.string(),
	actionRef: z.string(),
	nextTool: z.enum([EXECUTE, PROXY]),
	accountId: z.string(),
	connectionName: z.string(),
	provider: z.string(),
	label: z.string().optional(),
	effect: z.enum(["read", "write"]),
	inputSchema: z.unknown().optional(),
	inputs: z.unknown().optional(),
	schemaOmitted: z.literal(true).optional(),
	method: z.string().optional(),
	path: z.string().optional(),
});
const pageSchema = z.object({
	status: z.literal("ok"),
	result: z.object({
		items: z.array(z.unknown()),
		complete: z.boolean(),
		hosted: z.unknown().optional(),
	}),
});
const outcomesSchema = z.object({ items: z.array(z.unknown()) });
const unavailable = { status: "failed" as const, error: "PRELOAD_UNAVAILABLE" as const };
type Outcome =
	| typeof unavailable
	| { status: "ok"; result: { items: z.infer<typeof matchSchema>[]; complete: boolean } };
export type PreloadResult = { items: Outcome[] } | { error: "INVALID_PRELOAD" };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function readPreload(params: unknown): unknown {
	if (!params || typeof params !== "object" || !("_meta" in params)) return;
	const meta = params._meta;
	if (meta && typeof meta === "object" && preloadKey in meta) return meta[preloadKey];
}

// Desktop search can contain one local page and one authorized hosted page.
function compactOutcome(outcome: unknown, budget: number): Outcome {
	const local = pageSchema.safeParse(outcome).data?.result;
	if (!local) return unavailable;
	const hosted = pageSchema.safeParse(local.hosted).data?.result;
	const choices: {
		address: z.infer<typeof matchSchema>;
		full: z.infer<typeof matchSchema>;
		extraBytes: number;
	}[] = [];
	let complete = local.complete && (local.hosted === undefined || hosted?.complete === true);
	for (const raw of [...local.items, ...(hosted?.items ?? [])]) {
		const full = matchSchema.safeParse(raw).data;
		if (!full) continue; // Setup-only and inaccessible operations have no executable reference.
		const { inputSchema, inputs, ...identity } = full;
		const address =
			inputSchema === undefined && inputs === undefined
				? identity
				: { ...identity, schemaOmitted: true as const };
		const size = bytes(address);
		if (choices.length === 3 || size > budget) {
			complete = false;
			break;
		}
		budget -= size;
		choices.push({ address, full, extraBytes: bytes(full) - size });
	}
	// Reserve space for every connection choice before spending the rest on input schemas.
	const items = choices.map(({ address, full, extraBytes }) => {
		if (extraBytes > budget) return address;
		budget -= extraBytes;
		return full;
	});
	return { status: "ok", result: { items, complete } };
}

export async function resolvePreload(
	raw: unknown,
	lookup: (items: PreloadItem[]) => Promise<unknown>,
): Promise<PreloadResult | undefined> {
	if (raw === undefined) return;
	const request = requestSchema.safeParse(raw);
	if (!request.success) return { error: "INVALID_PRELOAD" };
	const items = request.data.items.map((item) => ({ ...item, connected: true as const }));
	try {
		const result = outcomesSchema.parse(await lookup(items));
		const budget = Math.floor(matchBudgetBytes / items.length);
		return { items: items.map((_, i) => compactOutcome(result.items[i], budget)) };
	} catch {
		return { items: items.map(() => unavailable) };
	}
}

/** Validate metadata returned by a Laplace runtime before presenting it through the CLI bridge. */
export function readPreloadResult(
	meta: Record<string, unknown> | undefined,
): PreloadResult | undefined {
	const raw = meta?.[preloadKey];
	if (z.object({ error: z.literal("INVALID_PRELOAD") }).safeParse(raw).success)
		return { error: "INVALID_PRELOAD" };
	const outcomes = z.object({ items: z.array(z.unknown()).min(1).max(10) }).safeParse(raw)
		.data?.items;
	if (outcomes)
		return {
			items: outcomes.map((item) =>
				compactOutcome(item, Math.floor(matchBudgetBytes / outcomes.length)),
			),
		};
}
type DiscoveryResult = {
	_meta?: Record<string, unknown>;
	instructions?: unknown;
	tools?: unknown;
};

// Hosts decide which response fields to pass to the model. Keep the standard tool catalog intact.
export function withPreload<T extends DiscoveryResult>(
	base: T,
	data: PreloadResult | undefined,
): T {
	if (!data) return base;
	const note =
		"Preloaded action matches (JSON data). Use nextTool with actionRef for the intended connection. Use LAPLACE_SEARCH if more detail is needed.\n" +
		JSON.stringify(data);
	return {
		...base,
		_meta: { ...base._meta, [preloadKey]: data },
		...(Array.isArray(base.tools)
			? {
					tools: base.tools.map((tool) =>
						tool.name === EXECUTE
							? { ...tool, description: [tool.description, note].filter(Boolean).join("\n") }
							: tool,
					),
				}
			: { instructions: [base.instructions, note].filter(Boolean).join("\n") }),
	};
}
