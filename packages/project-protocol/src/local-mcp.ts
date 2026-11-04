import { z } from "zod";

export const LOCAL_MCP_VERSION = "0.1.2";
export const HEARTBEAT_MS = 20_000;
export const OFFLINE_MS = 65_000;
export const MAX_MESSAGE_BYTES = 1_048_576;
export const localId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const toolName = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
export const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const secretHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const accountCode = z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
export const catalog = z.literal("custom");
export const health = z.enum(["starting", "online", "stopped", "needs_attention", "offline"]);
// Local snapshots preserve upstream schemas and metadata. Never send snapshots to Laplace.
export const toolSnapshot = z
	.object({
		name: toolName,
		description: z.string().optional(),
		title: z.string().optional(),
		outputSchema: z
			.object({ type: z.literal("object") })
			.catchall(z.unknown())
			.optional(),
		_meta: z.record(z.string(), z.unknown()).optional(),
		inputSchema: z.object({ type: z.literal("object") }).catchall(z.unknown()),
	})
	.catchall(z.unknown());
export type LocalTool = z.infer<typeof toolSnapshot>;
export const publicationSchema = z
	.object({
		localId,
		name: z.string().min(1).max(120),
		catalog,
		identity: z
			.string()
			.regex(/^[\p{L}\p{N}_%.-]{1,200}$/u)
			.optional(),
		revision,
		installedVersion: z.string().regex(/^[0-9A-Za-z.+_-]{1,64}$/),
		installedRevision: z.string().regex(/^[0-9A-Za-z._-]{1,80}$/),
		toolNames: z.array(toolName).max(300),
		initialEnabled: z.boolean().optional(),
		initialEnabledTools: z.array(toolName).max(300).optional(),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (new Set(v.toolNames).size !== v.toolNames.length)
			ctx.addIssue({ code: "custom", message: "Duplicate tools" });
		if (
			v.initialEnabledTools &&
			(new Set(v.initialEnabledTools).size !== v.initialEnabledTools.length ||
				v.initialEnabledTools.some((name) => !v.toolNames.includes(name)))
		)
			ctx.addIssue({
				code: "custom",
				message: "Initial permissions must be selected discovered tools",
			});
	});
export type Publication = z.infer<typeof publicationSchema>;
export interface Invocation {
	localId: string;
	revision: string;
	tool: string;
	input: Record<string, unknown>;
}
export const authorizationSchema = z
	.object({
		runId: z.string().uuid(),
		invocationId: z.string().uuid().optional(),
		localId,
		tool: toolName,
		catalogRevision: revision,
		permissionRevision: z.number().int().positive(),
		remote: z.boolean().optional(),
	})
	.strict();
export const heartbeatSchema = z
	.object({
		runId: z.string().uuid(),
		client: z.enum(["claude-code", "codex", "claude-desktop", "laplace-desktop", "other"]),
		version: z.string().regex(/^[0-9A-Za-z.+_-]{1,64}$/),
		connections: z
			.array(z.object({ localId, revision: revision.optional(), health }).strict())
			.max(50),
	})
	.strict();
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export const keepaliveSchema = heartbeatSchema.omit({ connections: true });
export const configurationRevisionSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const keepaliveResponseSchema = z
	.object({ healthy: z.literal(true), revision: configurationRevisionSchema })
	.strict();
export const configurationSchema = z
	.object({
		installationId: z.string().uuid(),
		accountId: z.string(),
		desiredVersion: z.string().nullable(),
		connections: z.array(
			z
				.object({
					localId,
					enabled: z.boolean(),
					toolNames: z.array(toolName),
					enabledTools: z.array(toolName),
					reviewedReads: z.array(toolName),
					catalogRevision: revision,
					permissionRevision: z.number().int().positive(),
					desiredVersion: z.string().nullable(),
				})
				.strict(),
		),
	})
	.strict();
export type Configuration = z.infer<typeof configurationSchema>;
export const configurationSnapshotSchema = z
	.object({ configuration: configurationSchema, revision: configurationRevisionSchema })
	.strict();
export const configurationEventSchema = z
	.object({ type: z.enum(["ready", "invalidate", "revoked"]) })
	.strict();
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
		)
		.join(",")}}`;
}
// A digest avoids separator/normalization collisions and stays stable across restarts.
export function scopedToolName(
	connection: string,
	tool: string,
	digest: (value: string) => string,
) {
	return `local_${connection.slice(0, 32)}_${digest(JSON.stringify([connection, tool])).slice(0, 32)}`;
}
export const connectorOriginSchema = z
	.string()
	.url()
	.refine((value) => {
		const u = new URL(value);
		return (
			!u.username &&
			!u.password &&
			!u.search &&
			!u.hash &&
			u.pathname === "/" &&
			(u.protocol === "https:" ||
				(u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname)))
		);
	}, "Use HTTPS, or an explicit loopback HTTP development origin")
	.transform((value) => new URL(value).origin);
