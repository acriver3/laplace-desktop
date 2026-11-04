import { z } from "zod";

const id = z.string().uuid();
const label = z.string().trim().min(1).max(200);
export const credentialSourceRef = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("bitwarden"), credentialId: id }).strict(),
	z
		.object({
			kind: z.literal("doppler"),
			connectionId: label,
			project: label,
			config: label,
			name: label,
		})
		.strict(),
]);
export type CredentialSourceRef = z.infer<typeof credentialSourceRef>;
export const dopplerScope = z
	.object({ connectionId: label, project: label, config: label })
	.strict();
export const brokerTarget = z
	.object({
		id,
		service: label,
		label,
		location: z.enum(["cloud", "local"]),
		authType: z.enum(["oauth2", "api_key", "custom_credential", "browser"]),
		connectionId: label.optional(),
		catalogId: label.optional(),
		setupRequestId: id.optional(),
	})
	.strict();
export const credentialMatch = z
	.object({
		field: label,
		source: credentialSourceRef,
		label: label.optional(),
		origins: z.array(z.string().url().max(2048)).max(20).optional(),
	})
	.strict();
export type CredentialMatch = z.infer<typeof credentialMatch>;
export const brokerItem = z
	.object({
		target: brokerTarget,
		matches: z.array(credentialMatch).max(20).default([]),
		state: z.enum([
			"matching",
			"review_required",
			"running",
			"user_action_required",
			"verifying",
			"connected",
			"failed",
			"cancelled",
			"expired",
		]),
		message: z.string().max(300).default(""),
		attempted: z.boolean().optional(),
		submittedPages: z.array(z.string().max(200)).max(32).optional(),
		connectorId: z.string().max(200).optional(),
		operationId: z.string().max(200).optional(),
		browserTargetId: z.string().max(128).optional(),
		expectedAccountId: z.string().max(200).optional(),
	})
	.strict();
export type BrokerItem = z.infer<typeof brokerItem>;
export const brokerSession = z
	.object({
		id,
		principalId: z.string().min(1).max(200),
		accountId: label.optional(),
		installationId: id.optional(),
		revision: z.number().int().nonnegative(),
		createdAt: z.number(),
		expiresAt: z.number(),
		items: z.array(brokerItem).min(1).max(50),
		receipts: z.record(z.string(), z.string()).default({}),
	})
	.strict();
export type BrokerSession = z.infer<typeof brokerSession>;
export const brokerCommand = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("start"),
			sessionId: id,
			targets: z.array(brokerTarget).min(1).max(50),
		})
		.strict(),
	z
		.object({
			action: z.literal("candidates"),
			sessionId: id,
			query: z.string().max(200).default(""),
			cursor: z.number().int().min(0).max(10000).default(0),
		})
		.strict(),
	z
		.object({
			action: z.literal("propose"),
			sessionId: id,
			itemId: id,
			matches: z.array(credentialMatch).min(1).max(20),
		})
		.strict(),
	z.object({ action: z.enum(["status", "review", "cancel", "desktop"]), sessionId: id }).strict(),
	z
		.object({
			action: z.literal("approve"),
			sessionId: id,
			capability: z.string().min(40).max(100),
			itemIds: z.array(id).min(1).max(50),
		})
		.strict(),
	z
		.object({
			action: z.literal("browser"),
			sessionId: id,
			itemId: id,
			operation: z.enum(["inspect", "advance", "focus", "verify"]),
			pageRevision: z.string().max(200).optional(),
		})
		.strict(),
]);
export type BrokerCommand = z.infer<typeof brokerCommand>;
export interface CredentialCandidate {
	source: CredentialSourceRef;
	label: string;
	origins?: string[];
}
export const BROKER_UI_URI = "ui://laplace/credential-broker.html";
export const brokerToolInput = z
	.object({
		requestId: id,
		installationId: id.optional(),
		accountId: label.optional(),
		command: brokerCommand.optional(),
		poll: z.boolean().optional(),
	})
	.strict();
export function brokerTools(local = false) {
	const prefix = local ? "local_credential_broker" : "credential_broker";
	return ["", ...(local ? ["_show"] : []), "_review", "_approve", "_prepare"].map((suffix) => ({
		name: prefix + suffix,
		description:
			suffix === "_show"
				? "Show the credential review MCP App directly in chat after proposing matches. Pass command action review and the sessionId. The user approves in this card; never approve on their behalf. Use Desktop review only when the host cannot render MCP Apps."
				: suffix === "_approve"
					? "Approve only the reviewed mappings selected by the user in the approval card."
					: suffix === "_review"
						? "Refresh the credential approval card."
						: `Connect or reauthenticate selected services using approved Bitwarden logins or Doppler references. Before setup, call local_credentials status for Desktop opt-in guidance. Start, discover candidates, propose mappings, then call ${local ? "local_credential_broker_show" : "credential_broker"} with command action review to display the approval MCP App in chat. Do not open Desktop for approval when MCP Apps are supported. Poll status or advance an approved login. Never request secret values. Authorize a new hosted assistant for metadata matching in Desktop first; vault unlock stays local. Hosted OAuth opens in the user’s regular Chrome profile through the Laplace extension after approval. Chrome may ask the user for site-specific extension access; no debugging connection is needed. Inspect and advance eligible login steps using the reviewed credential reference. MFA and OAuth consent require the user. Use a new requestId per operation; poll that same ID with poll=true while queued. Do not replay business actions after reauthentication.`,
		inputSchema: z.toJSONSchema(
			suffix === "_show"
				? brokerToolInput.extend({
						command: z
							.object({ action: z.literal("review"), sessionId: id })
							.strict()
							.optional(),
					})
				: brokerToolInput,
		) as { type: "object"; [key: string]: unknown },
		_meta: {
			ui: {
				resourceUri: BROKER_UI_URI,
				visibility:
					suffix === "_prepare"
						? ["model"]
						: suffix && suffix !== "_show"
							? ["app"]
							: ["app", "model"],
			},
		},
		annotations: {
			readOnlyHint: suffix === "_review" || suffix === "_show",
			destructiveHint: false,
			openWorldHint: true,
			idempotentHint: false,
		},
	}));
}
export function checkBrokerTool(name: string, input: z.infer<typeof brokerToolInput>) {
	const action = input.command?.action;
	if (name.endsWith("_prepare") && action !== "start")
		throw Error("Preparation requires a start command.");
	if (input.poll) {
		if (input.command) throw Error("Polling cannot include a command.");
		return;
	}
	if (!action) throw Error("A command is required.");
	if (
		name.endsWith("_approve")
			? action !== "approve"
			: name.endsWith("_review") || name.endsWith("_show")
				? action !== "review"
				: action === "approve"
	)
		throw Error("Use the approval card.");
}
export function brokerHandoff(sessionId: string, accountId: string, targets: unknown) {
	return (
		"Use Laplace credential_broker to connect these services. Session ID: " +
		sessionId +
		"\nAccount ID: " +
		accountId +
		"\nTargets: " +
		JSON.stringify(targets) +
		"\nFind the user's Desktop, start this session, match permitted credential metadata, and show the review card. Never return secret values. The user approves; pause for MFA and provider consent."
	);
}

/** Strip UI capabilities from every model-visible result, including asynchronous polls. */
export function brokerMcpResult(raw: unknown, input: unknown, tool: string) {
	const envelope = raw as {
		status?: string;
		result?: { view?: unknown; capability?: string; [key: string]: unknown };
		[key: string]: unknown;
	};
	const result = envelope.result;
	const { capability, ...publicResult } = result ?? {};
	const visible = result ? publicResult : envelope;
	return {
		content: [{ type: "text" as const, text: JSON.stringify(visible) }],
		structuredContent: visible,
		_meta: { brokerCapability: capability, brokerRouting: { ...(input as object), tool } },
	};
}
