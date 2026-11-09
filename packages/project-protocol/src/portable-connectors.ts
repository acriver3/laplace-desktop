import { z } from "zod";

import { localId, revision } from "./local-mcp";

export const connectorAccess = z
	.object({
		visible: z.boolean(),
		remoteEnabled: z.boolean(),
	})
	.strict()
	.refine((v) => v.visible || !v.remoteEnabled, "Hidden connectors cannot run remotely");
export const defaultConnectorAccess = { visible: true, remoteEnabled: false } as const;
export type ConnectorAccess = z.infer<typeof connectorAccess>;

// Only explicitly selected nonsecret values belong here. Launch settings and sessions never do.
export const portableSnapshot = z
	.object({
		version: z.literal(1),
		sourceId: localId,
		copiedFrom: z
			.object({ connectionId: z.string().uuid(), installationId: z.string().uuid(), localId })
			.strict()
			.optional(),
		platforms: z.array(z.string().max(40)).max(20).optional(),
		bundle: z.discriminatedUnion("kind", [
			z
				.object({
					kind: z.literal("catalog"),
					catalogId: localId,
					/** Installed npm version of `package`. */
					version: z.string().max(80),
					package: z
						.string()
						.max(214)
						.regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/)
						.optional(),
					/** Legacy MCPB pins from Desktop 0.1.42 and earlier; accepted but no longer used. */
					artifacts: z
						.array(
							z
								.object({
									sha256: revision,
									size: z.number().int().positive(),
									platforms: z.array(z.string()),
								})
								.strict(),
						)
						.optional(),
				})
				.strict(),
			z
				.object({
					kind: z.literal("custom"),
					sha256: revision,
					name: z.string().max(120),
					version: z.string().max(80),
				})
				.strict(),
		]),
		configuration: z.record(z.string().max(100), z.string().max(4096)).default({}),
	})
	.strict();
export type PortableSnapshot = z.infer<typeof portableSnapshot>;
export const installRequest = z
	.object({
		catalogId: localId.optional(),
		bundleFile: z.string().min(1).max(4096).optional(),
		snapshot: portableSnapshot.optional(),
		configuration: z.record(z.string().max(100), z.string().max(4096)).default({}),
		idempotencyKey: z.string().min(1).max(200),
	})
	.strict()
	.refine(
		(v) => [v.catalogId, v.bundleFile, v.snapshot].filter(Boolean).length === 1,
		"Choose one catalog connector, bundle file, or portable snapshot",
	);
export const managementCommand = z.discriminatedUnion("action", [
	z.object({ action: z.literal("install"), request: installRequest }).strict(),
	z
		.object({ action: z.literal("bulk"), requests: z.array(installRequest).min(1).max(50) })
		.strict(),
	z.object({ action: z.literal("access"), id: localId, access: connectorAccess }).strict(),
	z
		.object({
			action: z.literal("configure"),
			id: localId,
			configuration: z.record(z.string(), z.string()),
		})
		.strict(),
	z
		.object({
			action: z.enum(["authenticate", "verify", "repair", "remove", "retry", "cancel"]),
			id: localId,
		})
		.strict(),
]);
export const localManagementRequest = z.union([
	z
		.object({
			action: z.literal("copy"),
			sourceId: z.string().uuid(),
			idempotencyKey: z.string().min(1).max(200),
		})
		.strict(),
	managementCommand,
	z.object({ idempotencyKey: z.string().min(1).max(200), command: managementCommand }).strict(),
]);
export type ManagementCommand = z.infer<typeof managementCommand>;
export const managementRequest = z
	.object({
		installationId: z.string().uuid(),
		idempotencyKey: z.string().min(1).max(200),
		command: managementCommand,
	})
	.strict();
export const operationStatus = z.enum([
	"running",
	"needs_configuration",
	"needs_authentication",
	"ready",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
]);
export const portableOperation = z
	.object({
		id: z.string().uuid(),
		idempotencyKey: z.string(),
		fingerprint: revision,
		connectorId: localId,
		name: z.string().max(120).optional(),
		status: operationStatus,
		stage: z.string(),
		message: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
		catalogJobId: z.string().optional(),
		sourceId: localId.optional(),
	})
	.strict();
export type PortableOperation = z.infer<typeof portableOperation>;
/** Relay generation; 2 adds the selected hosted client's grant to every remote tool request. */
export const RELAY_PROTOCOL = 2;
const remoteGrant = {
	principal: z.string().min(1).max(200).optional(),
	grantRevision: z.number().int().positive().optional(),
};
export const relayRequest = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("tools"), localId, revision, ...remoteGrant }).strict(),
	z
		.object({
			kind: z.literal("call"),
			localId,
			revision,
			tool: z.string().max(128),
			input: z.record(z.string(), z.unknown()),
			...remoteGrant,
		})
		.strict(),
	z
		.object({
			kind: z.literal("manage"),
			operationId: z.string().uuid(),
			command: managementCommand,
		})
		.strict(),
	z.object({ kind: z.literal("status"), operationId: z.string().uuid() }).strict(),
]);
export type RelayRequest = z.infer<typeof relayRequest>;

/** Portable settings are explicitly classified; URL credentials/query state never sync. */
export function reusableConnectorSettings(values: Record<string, string>) {
	return Object.fromEntries(
		Object.entries(values).filter(([key, value]) => {
			if (!["workspace", "canvas_url"].includes(key)) return false;
			if (key === "workspace" && /^[a-zA-Z0-9_.-]{1,120}$/.test(value)) return true;
			try {
				const url = new URL(value);
				return (
					url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
				);
			} catch {
				return false;
			}
		}),
	);
}
