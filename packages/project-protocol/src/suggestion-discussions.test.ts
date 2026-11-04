import { describe, expect, it } from "vitest";

import { suggestionAnnotationSchema, suggestionDiscussion } from "./suggestions";

describe("annotation and discussion protocol", () => {
	const mark = {
		environment: "preview",
		revision: "r1",
		path: "/settings",
		x: 0.5,
		y: 0.2,
		width: 1280,
		height: 800,
		scrollX: 0,
		scrollY: 20,
	};
	it("rejects credentials, external URLs and unbounded coordinates", () => {
		expect(suggestionAnnotationSchema.safeParse(mark).success).toBe(true);
		for (const path of [
			"https://signed.example/page",
			"//example.com",
			"/settings?token=secret",
			"/settings#secret",
		])
			expect(suggestionAnnotationSchema.safeParse({ ...mark, path }).success).toBe(false);
		for (const x of [NaN, Infinity, -1, 1.1])
			expect(suggestionAnnotationSchema.safeParse({ ...mark, x }).success).toBe(false);
	});
	it("folds edits while preserving reply authorship and original creation time", () => {
		const initial = {
			event: "reply_added",
			id: "10000000-0000-4000-8000-000000000001",
			userId: "a",
			authorName: "Alice",
			body: "First",
			at: "2026-10-01",
		};
		const result = suggestionDiscussion([
			initial,
			{ ...initial, event: "reply_edited", body: "Updated", at: "2026-10-02" },
			{ ...initial, event: "reply_edited", userId: "b", body: "Forged" },
			{ event: "annotated", annotation: mark },
		]);
		expect(result.replies).toEqual([
			{
				id: initial.id,
				userId: "a",
				authorName: "Alice",
				body: "Updated",
				createdAt: initial.at,
				editedAt: "2026-10-02",
				version: 2,
			},
		]);
		expect(result.annotation).toEqual(mark);
	});
});
