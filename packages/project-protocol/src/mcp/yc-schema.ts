import { z } from "zod";

export const YC_UI_URI = "ui://laplace/yc-application-v2.html";
const identity = {
	accountId: z.string().min(1).max(200),
	connectionName: z.string().min(1).max(200),
	applicationId: z.string().uuid(),
};
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const ycChanges = z
	.record(z.string().min(1).max(100), z.string().max(20000))
	.refine(
		(value) => Object.keys(value).length > 0 && Object.keys(value).length <= 30,
		"Provide 1–30 changes",
	);
export const ycViewInput = z
	.object({
		accountId: identity.accountId.optional(),
		connectionName: identity.connectionName.optional(),
		applicationId: identity.applicationId.optional(),
		field: z.string().min(1).max(100).optional(),
	})
	.strict();
export const ycRenderInput = ycViewInput
	.extend({
		proposedChanges: ycChanges.optional(),
		expectedRevision: revision.optional(),
	})
	.refine(
		(value) =>
			!value.proposedChanges ||
			Boolean(
				value.applicationId && value.expectedRevision && value.accountId && value.connectionName,
			),
		{
			message:
				"Proposals require accountId, connectionName, applicationId and expectedRevision from the current view",
		},
	);
export const ycPreviewInput = z
	.object({ ...identity, expectedRevision: revision, changes: ycChanges })
	.strict();
export const ycSaveInput = ycPreviewInput.extend({ confirm: z.literal(true) });
export const ycQuestionSchema = z.object({
	field: z.string(),
	label: z.string(),
	helpText: z.string(),
	section: z.string(),
	order: z.number().int().nonnegative(),
	multiline: z.boolean(),
	editable: z.boolean(),
	maxLength: z.number().int().min(0).max(20000),
});
export const ycSnapshotSchema = z.object({
	applicationId: identity.applicationId,
	title: z.string(),
	url: z.string().url(),
	revision,
	answers: z.record(z.string(), z.string()),
	questions: z.array(ycQuestionSchema),
});
export const ycChangeSchema = z.object({
	field: z.string(),
	before: z.string(),
	after: z.string(),
});
export const ycViewSchema = z.object({
	kind: z.literal("yc_application"),
	state: z.enum(["accounts", "connections", "applications", "application", "reconnect"]),
	accounts: z.array(z.object({ accountId: z.string(), name: z.string() })),
	connections: z.array(
		z.object({ connectionName: z.string(), name: z.string(), status: z.string() }),
	),
	applications: z.array(
		z.object({ applicationId: identity.applicationId, title: z.string(), url: z.string().url() }),
	),
	accountId: z.string().optional(),
	connectionName: z.string().optional(),
	field: z.string().optional(),
	application: ycSnapshotSchema.optional(),
	changes: z.array(ycChangeSchema).optional(),
	saved: z.boolean().optional(),
	connectionsUrl: z.string().url(),
});
export type YcView = z.infer<typeof ycViewSchema>;
export type YcSnapshot = z.infer<typeof ycSnapshotSchema>;
export type YcChange = z.infer<typeof ycChangeSchema>;

const definitions = [
	[
		"get_yc_application_view",
		"Read authorized YC applications and their text questions. With no selection, show account/connection/application choices. To show the editor in chat, call render_yc_application.",
		ycViewInput,
		["model", "app"],
	],
	[
		"render_yc_application",
		"Show the interactive YC text draft editor in chat. Supply identifiers from get_yc_application_view. To suggest rewrites, pass proposedChanges and expectedRevision from that view, including other unsaved changes the user wants to keep. Proposals are unsaved: the user reviews and saves them in the editor. Never submit an application.",
		ycRenderInput,
		["model"],
	],
	[
		"preview_yc_draft",
		"Review text changes against the current YC revision without saving. Returns the current answers and before/after differences.",
		ycPreviewInput,
		["app"],
	],
	[
		"save_yc_draft",
		"Save reviewed text changes only after the user selects Save draft to YC. Requires confirm=true and the reviewed revision. Returns independently verified persisted answers. On failure read current state before retrying; never replay automatically. Never submits.",
		ycSaveInput,
		["app"],
	],
] as const;
export type YcToolName = (typeof definitions)[number][0];
export function isYcUiTool(name: string | undefined): name is YcToolName {
	return definitions.some(([candidate]) => candidate === name);
}
export const ycUiTools = definitions.map(([name, description, schema, visibility]) => ({
	name,
	description,
	inputSchema: z.toJSONSchema(schema, { io: "input" }),
	annotations: {
		readOnlyHint: name !== "save_yc_draft",
		destructiveHint: false,
		idempotentHint: name !== "save_yc_draft",
		openWorldHint: true,
	},
	_meta: {
		ui: {
			visibility: [...visibility],
			...(name === "render_yc_application" ? { resourceUri: YC_UI_URI } : {}),
		},
	},
}));

// Only these server-owned descriptors may grant YC UI access. Generic execution stays model-only.
export function ycToolMeta(name: string) {
	return ycUiTools.find((tool) => tool.name === name)?._meta;
}
