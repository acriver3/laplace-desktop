import { describe, expect, it } from "vitest";

import {
	appToolCatalogSchema,
	appToolRuntimeSchema,
	readAppToolJson,
	validateAppToolInput,
	withAppToolTimeout,
} from "./app-connections";

const tool = {
	name: "read_notes",
	description: "Read notes",
	inputSchema: {
		type: "object",
		properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
		required: ["limit"],
		additionalProperties: false,
	},
};
describe("app tools", () => {
	it("defaults to write access and rejects duplicate or unsafe names", () => {
		expect(appToolCatalogSchema.parse({ tools: [tool] }).tools[0].readOnly).toBe(false);
		expect(() => appToolCatalogSchema.parse({ tools: [tool, tool] })).toThrow();
		expect(() => appToolCatalogSchema.parse({ tools: [{ ...tool, name: "../sql" }] })).toThrow();
	});
	it("validates required fields, types, bounds and extra fields without eval", () => {
		const parsed = appToolCatalogSchema.parse({ tools: [tool] }).tools[0];
		expect(() => validateAppToolInput(parsed, { limit: 5 })).not.toThrow();
		for (const input of [{}, { limit: "5" }, { limit: 101 }, { limit: 5, sql: "DELETE" }])
			expect(() => validateAppToolInput(parsed, input)).toThrow();
	});
	it("requires an installation and tool name for invocation", () => {
		expect(() =>
			appToolRuntimeSchema.parse({
				appId: "c822172d-39c1-49aa-825c-f8c9412e45f1",
				actor: { userId: "user", organizationId: "org" },
				operation: "call",
			}),
		).toThrow();
	});
	it("rejects malformed live input schemas before discovery", () => {
		for (const inputSchema of [
			{ type: "object", properties: { value: { type: "invalid" } } },
			{ type: "object", required: "value" },
			{ type: "object", allOf: [null] },
			{ type: "object", minProperties: -1 },
			{ type: "object", properties: { value: { type: "number", multipleOf: 0 } } },
			{ type: "object", $ref: "https://private.example/schema" },
		])
			expect(() => appToolCatalogSchema.parse({ tools: [{ ...tool, inputSchema }] })).toThrow();
	});
	it("bounds hanging app code and clears the deadline after success", async () => {
		let interrupted: AbortSignal | undefined;
		await expect(
			withAppToolTimeout(async (signal) => {
				interrupted = signal;
				return new Promise(() => {});
			}, 5),
		).rejects.toThrow("timed out");
		expect(interrupted?.aborted).toBe(true);
		await expect(withAppToolTimeout(async () => ({ ok: true }), 5)).resolves.toEqual({ ok: true });
	});
	it("bounds streamed JSON and rejects failed or invalid responses", async () => {
		await expect(readAppToolJson(Response.json({ ok: true }))).resolves.toEqual({ ok: true });
		await expect(readAppToolJson(new Response("bad", { status: 500 }))).rejects.toThrow();
		await expect(readAppToolJson(new Response("bad"))).rejects.toThrow();
		await expect(readAppToolJson(new Response('"oversized"'), 4)).rejects.toThrow("too large");
	});
});
