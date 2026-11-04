import { z } from "zod";

import { brokerCommand } from "./credential-broker";

const id = z.string().uuid();
const routing = { accountId: z.string().max(200).optional(), installationId: id.optional() };
const request = { ...routing, requestId: id };
export const MAX_CREDENTIAL_BINDINGS = 10000;
export const localCommand = z
	.object({
		executable: z
			.string()
			.min(1)
			.max(4096)
			.refine((v) => !v.includes("\0")),
		cwd: z
			.string()
			.min(1)
			.max(4096)
			.refine((v) => !v.includes("\0")),
		args: z
			.array(
				z
					.string()
					.max(4096)
					.refine((v) => !v.includes("\0")),
			)
			.max(100)
			.default([]),
		env: z
			.record(
				z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
				z.string().regex(/^(username|password|custom:[^\r\n\0]{1,100})$/),
			)
			.refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 10),
		runtimeSeconds: z.number().int().min(1).max(3600).default(60),
	})
	.strict();
export const credentialInput = z.discriminatedUnion("action", [
	z
		.object({
			...request,
			action: z.literal("run_command"),
			credentialId: id,
			command: localCommand,
		})
		.strict(),
	z.object({ ...request, action: z.literal("broker"), command: brokerCommand }).strict(),
	z.object({ ...routing, action: z.literal("devices") }).strict(),
	z.object({ ...routing, action: z.enum(["status", "targets"]), requestId: id }).strict(),
	z
		.object({
			...request,
			action: z.literal("list"),
			cursor: z
				.string()
				.regex(/^(0|[1-9][0-9]{0,5})$/)
				.optional(),
		})
		.strict(),
	z
		.object({
			...request,
			action: z.literal("fill"),
			credentialId: id,
			targetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
			fields: z
				.array(z.enum(["username", "password", "totp"]))
				.min(1)
				.max(3),
		})
		.strict(),
	z
		.object({
			...request,
			action: z.enum(["http", "run"]),
			actionId: id,
			parameters: z.record(z.string().max(80), z.string().max(2000)).default({}),
		})
		.strict(),
	z.object({ ...request, action: z.enum(["result", "cancel"]) }).strict(),
]);
export type CredentialInput = z.infer<typeof credentialInput>;
export const credentialTool = {
	name: "use_local_credential",
	description:
		"Use Bitwarden credentials on your running Laplace Desktop without receiving secret values. Call devices (hosted only), then status/list/targets. For list, pass nextCursor as cursor in a new list request to get the next page until nextCursor is absent. Fill an existing, user-configured CDP browser tab or execute a user-configured HTTP/command action. Use a new UUID requestId per operation and reuse it only for an identical retry. Poll result with that ID while pending; approvals and vault unlock happen only in Laplace Desktop. Never request a password in chat. Unsupported/cloud browser sessions cannot be filled. A filled field remains readable by the site and other browser tools; Laplace cannot redact another agent's browser outputs.",
	inputSchema: {
		type: "object" as const,
		properties: {
			action: {
				type: "string",
				enum: ["devices", "status", "list", "targets", "fill", "http", "run", "result", "cancel"],
			},
			accountId: { type: "string" },
			installationId: { type: "string" },
			requestId: { type: "string", format: "uuid" },
			cursor: { type: "string", description: "For list only: nextCursor from the previous page." },
			credentialId: { type: "string", format: "uuid" },
			targetId: { type: "string" },
			fields: { type: "array", items: { type: "string", enum: ["username", "password", "totp"] } },
			actionId: { type: "string", format: "uuid" },
			parameters: { type: "object", additionalProperties: { type: "string" } },
		},
		required: ["action"],
		additionalProperties: false,
	},
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
};

// Keep the existing local name and principal separate from hosted relay requests.
export const localCredentialTool = {
	...credentialTool,
	name: "local_credentials",
	description:
		credentialTool.description +
		" Available before setup: status returns onboarding guidance without credential metadata. For any local command or agent process, use run_command with an approved credential handle and command (absolute executable/cwd, literal args, env mapping to username/password/custom:field, runtimeSeconds up to 3600). Desktop displays the exact command and mapping for one-time approval. Secret values go only into the child environment; stdout/stderr are withheld. No shell is implicitly invoked. The process can access the granted secrets. Never put secrets in arguments.",
	inputSchema: {
		...credentialTool.inputSchema,
		properties: {
			...credentialTool.inputSchema.properties,
			action: {
				type: "string",
				enum: [...credentialTool.inputSchema.properties.action.enum, "run_command"],
			},
			command: z.toJSONSchema(localCommand),
		},
	},
};

export const credentialField = z
	.string()
	.regex(/^(username|password|totp|custom:[^\r\n]{1,100})$/)
	.refine((value) => !value.includes("\0"));
const text = z
	.string()
	.max(4096)
	.refine((v) => !v.includes("\0"));
export const credentialBinding = z
	.object({
		id,
		label: z.string().trim().min(1).max(100),
		itemId: id,
		origins: z
			.array(
				z
					.string()
					.url()
					.refine((v) => {
						const u = new URL(v);
						return u.protocol === "https:" && u.origin === v && !u.username && !u.password;
					}),
			)
			.max(20)
			.default([]),
	})
	.strict();
const actionBase = {
	id,
	label: z.string().min(1).max(100),
	credentialId: id,
	parameters: z
		.record(
			z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
			z.array(z.string().max(2000)).min(1).max(100),
		)
		.default({}),
	// Only explicitly selected top-level scalar JSON fields may leave the executor.
	resultFields: z
		.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/))
		.max(20)
		.default([]),
};
export const credentialAction = z.discriminatedUnion("kind", [
	z
		.object({
			...actionBase,
			kind: z.literal("http"),
			url: z
				.string()
				.url()
				.max(4096)
				.refine((v) => {
					const u = new URL(v);
					return u.protocol === "https:" && !u.username && !u.password && !u.hash;
				}),
			method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
			header: z.string().regex(/^(Authorization|X-[A-Za-z0-9-]+)$/i),
			prefix: z.enum(["Bearer ", "Basic ", ""]).default("Bearer "),
			field: credentialField,
			body: z.record(z.string().max(80), text).optional(),
		})
		.strict(),
	z
		.object({
			...actionBase,
			kind: z.literal("command"),
			executable: text.min(1),
			cwd: text.min(1),
			args: z.array(text).max(100).default([]),
			env: z
				.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/), credentialField)
				.refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 10),
		})
		.strict(),
]);
export type CredentialAction = z.infer<typeof credentialAction>;
export const credentialSettings = z
	.object({
		enabled: z.boolean().default(false),
		wholeVaultMatching: z.boolean().default(false),
		hosted: z.boolean().default(false),
		brokerAssistants: z
			.array(
				z
					.object({ id: z.string().startsWith("hosted:").max(200), name: z.string().max(200) })
					.strict(),
			)
			.max(50)
			.default([]),
		bwPath: text.default("bw"),
		managedBitwarden: z.boolean().default(false),
		bitwardenServer: z
			.string()
			.url()
			.default("https://vault.bitwarden.com")
			.refine((v) => {
				const u = new URL(v);
				return (
					u.protocol === "https:" &&
					!u.username &&
					!u.password &&
					!u.search &&
					!u.hash &&
					u.pathname === "/"
				);
			}),
		setupComplete: z.boolean().default(false),
		setupStep: z.enum(["connect", "signIn", "logins", "assistants", "browser"]).default("connect"),
		bitwardenAccountId: z.string().uuid().optional(),
		cdpEndpoint: z.string().max(4096).default(""),
		clients: z.array(id).max(50).default([]),
		bindings: z.array(credentialBinding).max(MAX_CREDENTIAL_BINDINGS).default([]),
		actions: z.array(credentialAction).max(100).default([]),
	})
	.strict()
	.superRefine((v, ctx) => {
		for (const list of [v.bindings, v.actions])
			if (new Set(list.map((x) => x.id)).size !== list.length)
				ctx.addIssue({ code: "custom", message: "Duplicate identifiers" });
		if (v.actions.some((a) => !v.bindings.some((b) => b.id === a.credentialId)))
			ctx.addIssue({ code: "custom", message: "Action references an unknown credential" });
	});
export type CredentialSettings = z.infer<typeof credentialSettings>;
