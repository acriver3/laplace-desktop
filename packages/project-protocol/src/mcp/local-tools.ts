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
