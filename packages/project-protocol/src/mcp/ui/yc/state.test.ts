import { expect, it } from "vitest";

import type { YcSnapshot } from "../../yc-schema";
import {
	answer,
	chooseProposal,
	editAnswer,
	mergeSnapshot,
	resolveConflict,
	validation,
} from "./state";
const snapshot: YcSnapshot = {
	applicationId: "12345678-1234-4234-8234-123456789abc",
	title: "Example",
	url: "https://apply.ycombinator.com/",
	revision: "a".repeat(64),
	answers: { name: "Original", describe: "First answer" },
	questions: ["name", "describe"].map((field, order) => ({
		field,
		order,
		label: field,
		helpText: "",
		section: "Company",
		maxLength: 50,
		editable: true,
		multiline: true,
	})),
};
it("stages initial suggestions and allows rejecting them without saving", () => {
	const draft = mergeSnapshot(undefined, snapshot, [
		{ field: "describe", before: "First answer", after: "Proposed" },
	]);
	expect(answer(draft, "describe")).toBe("Proposed");
	expect(draft.proposals.describe.staged).toBe(true);
	expect(chooseProposal(draft, "describe", false).edits).toEqual({});
});
it("keeps local typing when an overlapping suggestion arrives", () => {
	const original = editAnswer(
		mergeSnapshot(undefined, snapshot),
		"describe",
		"My unfinished answer",
	);
	const incoming = mergeSnapshot(original, snapshot, [
		{ field: "describe", before: "First answer", after: "AI answer" },
	]);
	expect(answer(incoming, "describe")).toBe("My unfinished answer");
	expect(incoming.proposals.describe.staged).toBe(false);
	expect(answer(chooseProposal(incoming, "describe", true), "describe")).toBe("AI answer");
	expect(answer(chooseProposal(incoming, "describe", false), "describe")).toBe(
		"My unfinished answer",
	);
});
it("preserves drafts on refresh, requires decisions for overlaps, and clears verified edits", () => {
	let draft = editAnswer(mergeSnapshot(undefined, snapshot), "describe", "Local");
	draft = mergeSnapshot(draft, {
		...snapshot,
		revision: "b".repeat(64),
		answers: { ...snapshot.answers, describe: "External" },
	});
	expect(answer(draft, "describe")).toBe("Local");
	expect(draft.conflicts).toEqual(["describe"]);
	expect(validation(draft)).toContain("Choose");
	expect(resolveConflict(draft, "describe", false).edits).toEqual({});
	draft = resolveConflict(draft, "describe", true);
	expect(validation(draft)).toBeUndefined();
	expect(
		mergeSnapshot(draft, { ...draft.snapshot, answers: { ...snapshot.answers, describe: "Local" } })
			.edits,
	).toEqual({});
});
it("invalidates review on typing and checks limits and removed fields", () => {
	const reviewed = {
		...mergeSnapshot(undefined, snapshot),
		review: { revision: snapshot.revision, changes: [] },
	};
	const long = editAnswer(reviewed, "describe", "x".repeat(51));
	expect(long.review).toBeUndefined();
	expect(validation(long)).toContain("50");
	expect(validation(mergeSnapshot(long, { ...snapshot, questions: [] }))).toContain(
		"no longer available",
	);
	expect(validation({ ...reviewed, needsRefresh: true })).toContain("Refresh");
});
