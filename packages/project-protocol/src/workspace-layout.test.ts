import { describe, expect, it } from "vitest";

import { defaultWorkspaceLayout, workspaceLayoutSchema } from "./workspace";

describe("workspace details preferences", () => {
	it("round-trips the Files selection without changing saved zoom or collapse preferences", () => {
		const layout = {
			...defaultWorkspaceLayout(),
			selectedPanel: "files" as const,
			collaboratorsCollapsed: true,
			appZoom: 75,
		};
		expect(workspaceLayoutSchema.parse(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
	});

	it("preserves existing layouts and migrates legacy chat to Changes", () => {
		for (const selectedPanel of [null, "assistant", "activity"] as const) {
			const layout = { ...defaultWorkspaceLayout(), selectedPanel, sidebarCollapsed: true };
			expect(workspaceLayoutSchema.parse(layout)).toEqual(layout);
		}
		const legacy = { ...defaultWorkspaceLayout(), schemaVersion: 5, selectedPanel: "chat" };
		expect(workspaceLayoutSchema.parse(legacy)).toEqual({
			...defaultWorkspaceLayout(),
			selectedPanel: "suggestions",
		});
	});
});
