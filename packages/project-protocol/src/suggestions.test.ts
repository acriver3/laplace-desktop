import { describe, expect, it } from "vitest";

import { projectTools, toolInputs, SERVER_INSTRUCTIONS } from "./index";
import { suggestionBodySchema, suggestionIsStalled } from "./suggestions";

const project_id = "10000000-0000-4000-8000-000000000001";
const task_context = {
	suggestion_id: "10000000-0000-4000-8000-000000000002",
	claim_id: "10000000-0000-4000-8000-000000000003",
	agent_session_id: "session",
};
describe("suggestion protocol", () => {
	it("instructs completion with the latest preview operation, including optional verification", () => {
		const description = projectTools.find(
			(tool) => tool.name === "update_suggestion_task",
		)!.description;
		for (const instructions of [description, SERVER_INSTRUCTIONS]) {
			expect(instructions).toContain("After source edit A and verification B, report B");
			expect(instructions).toContain("without later verification, report A");
			expect(instructions).toContain("deploymentOperationId in list_suggestion_tasks");
			expect(instructions).not.toContain("final source mutation request_id");
		}
	});
	it("advertises inbox reads separately from atomic claims and progress mutations", () => {
		for (const [name, readOnlyHint] of [
			["list_suggestion_tasks", true],
			["claim_suggestion_task", false],
			["update_suggestion_task", false],
		] as const)
			expect(projectTools.find((tool) => tool.name === name)?.annotations).toMatchObject({
				readOnlyHint,
			});
	});
	it("keeps source mutation callers compatible and validates optional task context", () => {
		const patch = {
			project_id,
			request_id: task_context.claim_id,
			expected_revision: "r",
			patch: "patch",
		};
		expect(toolInputs.apply_patch.safeParse(patch).success).toBe(true);
		expect(toolInputs.apply_patch.safeParse({ ...patch, task_context }).success).toBe(true);
		expect(
			toolInputs.apply_patch.safeParse({
				...patch,
				task_context: { ...task_context, user_id: "forged" },
			}).success,
		).toBe(false);
		expect(
			toolInputs.update_suggestion_task.safeParse({ project_id, status: "working" }).success,
		).toBe(false);
	});
	it("requires non-empty bounded plain text and stalls only active work", () => {
		expect(suggestionBodySchema.parse(" Search ")).toBe("Search");
		for (const text of [" ", "x".repeat(4001)])
			expect(suggestionBodySchema.safeParse(text).success).toBe(false);
		expect(
			suggestionIsStalled({ executionStatus: "working", heartbeatAt: new Date(1000) }, 91_000),
		).toBe(true);
		for (const executionStatus of ["queued", "failed", "implemented", null])
			expect(suggestionIsStalled({ executionStatus, heartbeatAt: null })).toBe(false);
	});
});
