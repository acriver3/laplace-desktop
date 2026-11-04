import { describe, expect, it } from "vitest";

import { currentRuntimeVerification, projectSummary } from "./summary";

describe("current runtime verification", () => {
	it("never treats a historical browser result or another revision as current assurance", () => {
		for (const verification of [
			{ revision: "active", verification: "passed" as const },
			{ kind: "build-runtime" as const, revision: "previous", verification: "passed" as const },
		]) {
			const state = { preview_revision: "active", verification };
			expect(currentRuntimeVerification(state)).toBeUndefined();
			expect(projectSummary(state).verification).toBe("Not run");
		}
	});

	it.each([
		["passed", "Passed"],
		["failed", "Failed"],
		["pending", "Checking"],
		["unavailable", "Unavailable"],
	] as const)("reports current build/runtime %s independently from deployment", (status, label) => {
		const state = {
			preview_revision: "active",
			live_revision: "published",
			verification: { kind: "build-runtime" as const, revision: "active", verification: status },
		};
		expect(projectSummary(state)).toEqual({
			preview: "Deployed",
			verification: label,
			live: "Published",
		});
	});

	it("requires a current structured result even when a legacy phase reports success or failure", () => {
		const state = {
			preview_revision: "active",
			environment_status: { preview: "verification_failed", live: "idle" },
		};
		expect(projectSummary(state).verification).toBe("Not run");
	});
});
