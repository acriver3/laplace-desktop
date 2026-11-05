import { z } from "zod";

import { connectorOriginSchema, scopedToolName, type LocalTool } from "../local-mcp";

/** Scoped connector names stay reserved even when their process/catalog is unavailable. */
export function isLocalConnectorToolName(name: string): boolean {
	return /^local_[A-Za-z0-9_-]{1,32}_[a-f0-9]{32}$/.test(name);
}

/** Preserve connector schemas and metadata while keeping local names and hints consistent. */
export function localConnectorTool(
	tool: LocalTool,
	server: { id: string; name: string },
	digest: (value: string) => string,
) {
	return {
		...tool,
		name: scopedToolName(server.id, tool.name, digest),
		title: `${server.name}: ${tool.name}`,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
	};
}

export const manageSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("import"),
			file: z.string().min(1),
			selected: z.array(z.string()).min(1).max(50),
			confirm: z.literal(true),
		})
		.strict(),
	z.object({ action: z.literal("repair"), id: z.string(), confirm: z.literal(true) }).strict(),
	z.object({ action: z.literal("remove"), id: z.string(), confirm: z.literal(true) }).strict(),
]);

export const setupSchema = z
	.object({ origin: connectorOriginSchema, name: z.string().min(1).max(120).default("Local MCP") })
	.strict();

export const statusSchema = z.object({}).strict();

export const localBootstrapTools = [
	{
		name: "laplace_local_setup",
		description:
			"Link this installation to Laplace. Returns a browser approval URL promptly. Open it and approve in the selected account, then run status.",
		inputSchema: z.toJSONSchema(setupSchema, { io: "input" }),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
	},
	{
		name: "laplace_local_status",
		description:
			"Inspect local linking, permissions, versions and health. Restart clients with a stale catalog. No tool arguments or results are sent to Laplace.",
		inputSchema: { type: "object", additionalProperties: false },
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
	{
		name: "laplace_local_manage",
		description:
			"Attach selected custom connector configurations, explicitly repair a connection, or remove it. For import, review the selected server's executable, arguments, working directory and credential sources locally, then pass confirm:true. Build, install and authenticate connectors locally before attaching them. AI client permissions govern approval.",
		inputSchema: { type: "object", ...z.toJSONSchema(manageSchema, { io: "input" }) },
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
	},
];

export const browserSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("install") }).strict(),
	z.object({ action: z.literal("catalog") }).strict(),
	z
		.object({
			action: z.literal("setup"),
			catalogId: z.string().min(1).max(100),
			workspace: z.string().url().optional(),
			id: z
				.string()
				.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
				.optional(),
			name: z.string().min(1).max(200).optional(),
		})
		.strict(),
	z.object({ action: z.literal("authenticate"), id: z.string().min(1).max(80) }).strict(),
	z
		.object({
			action: z.literal("migrate"),
			id: z.string().min(1).max(80),
			catalogId: z.string().min(1).max(100),
			workspace: z.string().url().optional(),
			confirm: z.literal(true),
		})
		.strict(),
	z
		.object({
			action: z.literal("rollback"),
			id: z.string().min(1).max(80),
			confirm: z.literal(true),
		})
		.strict(),
	z.object({ action: z.literal("status") }).strict(),
	z.object({ action: z.literal("disconnect"), id: z.string().min(1).max(80) }).strict(),
	z.object({ action: z.literal("uninstall"), confirm: z.literal(true) }).strict(),
]);
export const localBrowserTools = [
	{
		name: "laplace_local_browser",
		description:
			"Install the shared browser bridge, list verified connector setup instructions, set up a catalog connector, authenticate its existing Chrome account, inspect status, or disconnect. Authentication returns a user approval URL. Never approve on the user's behalf. Imported connections need explicit migration. Setup verifies only reads.",
		inputSchema: { type: "object", ...z.toJSONSchema(browserSchema, { io: "input" }) },
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
	},
];

export const browserApprovalSchemas = {
	local_connectors_browser_show: z.object({ requestId: z.string().uuid() }).strict(),
	local_connectors_browser_review: z.object({ requestId: z.string().uuid() }).strict(),
	local_connectors_browser_approve: z
		.object({ requestId: z.string().uuid(), capability: z.string().min(40).max(100) })
		.strict(),
	local_connectors_browser_cancel: z.object({ requestId: z.string().uuid() }).strict(),
	local_connectors_browser_focus: z
		.object({ requestId: z.string().uuid(), profileId: z.string().uuid() })
		.strict(),
};
export const localBrowserApprovalTools = Object.entries(browserApprovalSchemas).map(
	([name, schema]) => ({
		name,
		description: name.endsWith("_show")
			? "Show the browser approval card for this authentication request. Only the user may approve the account."
			: "Browser approval card action. Only perform approval when the user clicks Approve connection.",
		inputSchema: { type: "object", ...z.toJSONSchema(schema, { io: "input" }) },
		_meta: {
			ui: {
				...(name.endsWith("_show") ? { resourceUri: "ui://laplace/browser-approval.html" } : {}),
				visibility: [name.endsWith("_show") ? "model" : "app"],
			},
		},
		annotations: {
			readOnlyHint: name.endsWith("_show") || name.endsWith("_review"),
			destructiveHint: false,
			openWorldHint: true,
		},
	}),
);
