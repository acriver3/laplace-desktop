import { z } from "zod";

export const PANEL_IDS = ["tools", "preview", "live"] as const;
export const TOOL_IDS = [
	"assistant",
	"chat",
	"activity",
	"design",
	"source",
	"database",
	"history",
	"logs",
	"github",
] as const;
export type ToolId = (typeof TOOL_IDS)[number];
export type PanelId = (typeof PANEL_IDS)[number];
const panel = z
	.object({ collapsed: z.boolean(), height: z.number().finite().min(0.2).max(1) })
	.strict();
const legacyWorkspaceLayoutSchema = z
	.object({
		schemaVersion: z.literal(1),
		columnRatio: z.number().finite().min(0.2).max(0.8),
		panels: z
			.object({
				preview: panel,
				live: panel,
				source: panel,
				database: panel,
				history: panel,
				logs: panel,
				chat: panel,
				assistant: panel,
			})
			.strict(),
	})
	.strict();
const currentWorkspaceLayoutSchema = z
	.object({
		schemaVersion: z.literal(2),
		columnRatio: z.number().finite().min(0.2).max(0.8),
		activeTool: z.enum(TOOL_IDS),
		panels: z.object({ tools: panel, preview: panel, live: panel }).strict(),
	})
	.strict();
const previousWorkspaceLayoutSchema = z.union([
	currentWorkspaceLayoutSchema,
	legacyWorkspaceLayoutSchema.transform((legacy) => {
		const expanded = (["chat", "assistant", "source", "database", "history", "logs"] as const).find(
			(id) => !legacy.panels[id].collapsed,
		);
		const activeTool = expanded ?? "source";
		return {
			schemaVersion: 2 as const,
			columnRatio: legacy.columnRatio,
			activeTool,
			panels: {
				tools: { collapsed: !expanded, height: legacy.panels[activeTool].height },
				preview: legacy.panels.preview,
				live: legacy.panels.live,
			},
		};
	}),
]);
export const zoomSchema = z.union([z.literal("fit"), z.number().finite().positive()]);
const placementSchema = z
	.object({ column: z.union([z.literal(0), z.literal(1)]), order: z.number().int().min(0).max(2) })
	.strict();
const v3WorkspaceLayoutSchema = z.union([
	currentWorkspaceLayoutSchema
		.extend({
			schemaVersion: z.literal(3),
			placements: z
				.object({ tools: placementSchema, preview: placementSchema, live: placementSchema })
				.strict(),
			zoom: z.object({ preview: zoomSchema, live: zoomSchema }).strict(),
		})
		.strict()
		.refine(
			(layout) =>
				new Set(
					PANEL_IDS.map((id) => `${layout.placements[id].column}:${layout.placements[id].order}`),
				).size === PANEL_IDS.length,
			"Widgets must have distinct positions",
		),
	previousWorkspaceLayoutSchema.transform((layout) => ({
		...layout,
		schemaVersion: 3 as const,
		placements: defaultPlacements(),
		zoom: { preview: "fit" as const, live: "fit" as const },
	})),
]);
function defaultPlacements() {
	return {
		tools: { column: 0 as const, order: 0 },
		preview: { column: 1 as const, order: 0 },
		live: { column: 1 as const, order: 1 },
	};
}
const viewSchema = z.union([
	z.enum(["preview", "live", ...TOOL_IDS]),
	z
		.string()
		.startsWith("designs/")
		.max(240)
		.refine(
			(path) =>
				!/[\\\u0000-\u001f:]/.test(path) &&
				!path.split("/").some((part) => !part || part === "." || part === ".."),
		),
]);
export const consoleTabSchema = z
	.object({
		id: z.string().min(1).max(260),
		view: viewSchema,
		reusable: z.boolean().default(false),
		floating: z.boolean().default(false),
		maximized: z.boolean().default(false),
		bounds: z
			.object({
				x: z.number().finite().min(0).max(10000),
				y: z.number().finite().min(0).max(10000),
				width: z.number().finite().min(280).max(10000),
				height: z.number().finite().min(200).max(10000),
			})
			.default({ x: 24, y: 24, width: 640, height: 480 }),
	})
	.strict();
const consoleSchema = z
	.object({
		tabs: z.array(consoleTabSchema).min(1).max(40),
		activeTab: z.string().max(260),
		sidebarCollapsed: z.boolean(),
		collaboratorsCollapsed: z.boolean().default(false),
	})
	.strict()
	.refine(
		(c) =>
			new Set(c.tabs.map((t) => t.id)).size === c.tabs.length &&
			new Set(c.tabs.map((t) => t.view)).size === c.tabs.length &&
			c.tabs.some((t) => t.id === c.activeTab),
		"Tabs must have unique identities and views and an active tab",
	);
export type ConsoleTab = z.output<typeof consoleTabSchema>;
export function defaultConsole(activeTool: ToolId = "assistant") {
	return {
		tabs: [
			consoleTabSchema.parse({ id: "preview", view: "preview" }),
			consoleTabSchema.parse({ id: "live", view: "live" }),
			consoleTabSchema.parse({ id: "tools", view: activeTool, reusable: true }),
		],
		activeTab: "preview",
		sidebarCollapsed: false,
		collaboratorsCollapsed: false,
	};
}
const v4WorkspaceLayoutSchema = z.union([
	z
		.object({
			schemaVersion: z.literal(4),
			console: consoleSchema,
			zoom: z.object({ preview: zoomSchema, live: zoomSchema }),
			columnRatio: z.number().finite().min(0.2).max(0.8),
			activeTool: z.enum(TOOL_IDS),
			panels: z.object({ tools: panel, preview: panel, live: panel }),
			placements: z.object({
				tools: placementSchema,
				preview: placementSchema,
				live: placementSchema,
			}),
		})
		.strict(),
	v3WorkspaceLayoutSchema.transform((layout) => ({
		...layout,
		schemaVersion: 4 as const,
		console: {
			...defaultConsole(layout.activeTool),
			activeTab:
				!layout.panels.tools.collapsed &&
				["chat", "activity", "assistant"].includes(layout.activeTool)
					? "tools"
					: "preview",
		},
	})),
]);
const legacyCollaborationPanelSchema = z.enum(["chat", "activity", "assistant"]).nullable();
export const collaborationPanelSchema = z
	.enum(["suggestions", "activity", "assistant", "files"])
	.nullable();
export type CollaborationPanel = z.output<typeof collaborationPanelSchema>;
const v5WorkspaceLayoutSchema = z
	.object({
		schemaVersion: z.literal(5),
		selectedPanel: legacyCollaborationPanelSchema,
		sidebarCollapsed: z.boolean(),
		collaboratorsCollapsed: z.boolean(),
		appZoom: zoomSchema,
	})
	.strict();
const legacyWorkspaceSchema = z.union([
	v5WorkspaceLayoutSchema,
	v4WorkspaceLayoutSchema.transform((legacy) => {
		const selected = legacy.console.tabs.find((tab) => tab.id === legacy.console.activeTab)?.view;
		return {
			schemaVersion: 5 as const,
			selectedPanel:
				selected === "chat"
					? ("chat" as const)
					: selected === "activity"
						? ("activity" as const)
						: selected === "assistant"
							? ("assistant" as const)
							: null,
			sidebarCollapsed: legacy.console.sidebarCollapsed,
			collaboratorsCollapsed: legacy.console.collaboratorsCollapsed,
			appZoom: legacy.zoom.preview,
		};
	}),
]);
const v6WorkspaceLayoutSchema = v5WorkspaceLayoutSchema.extend({
	schemaVersion: z.literal(6),
	selectedPanel: collaborationPanelSchema,
});
export const workspaceLayoutSchema = z.union([
	v6WorkspaceLayoutSchema,
	legacyWorkspaceSchema.transform((legacy) => ({
		...legacy,
		schemaVersion: 6 as const,
		selectedPanel:
			legacy.selectedPanel === "chat" ? ("suggestions" as const) : legacy.selectedPanel,
	})),
]);
export type WorkspaceLayout = z.output<typeof workspaceLayoutSchema>;
export type WorkspaceLayoutInput = z.input<typeof workspaceLayoutSchema>;
export function defaultWorkspaceLayout(): WorkspaceLayout {
	return {
		schemaVersion: 6,
		selectedPanel: null,
		sidebarCollapsed: false,
		collaboratorsCollapsed: true,
		appZoom: "fit",
	};
}
export const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);
