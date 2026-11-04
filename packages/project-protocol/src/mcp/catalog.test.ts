import { expect, it, vi } from "vitest";

import {
	ToolCatalog,
	ToolUnavailableError,
	type CatalogContext,
	type CatalogEntry,
} from "./catalog";

const entry: CatalogEntry = {
	id: "credentials:local",
	tool: { name: "local_credentials" },
	route: { executor: "credentials", target: "local" },
	requirements: {
		connections: ["desktop"],
		scopes: ["credentials:use"],
		features: ["credentials"],
	},
};
const desktop: CatalogContext = {
	connection: "desktop",
	transport: "http",
	scopes: ["credentials:use"],
	features: ["credentials"],
};

it("allows local execution over either transport but denies the same tool in hosted context", () => {
	for (const transport of ["stdio", "http"] as const)
		expect(new ToolCatalog({ ...desktop, transport }, [entry]).tools()).toEqual([entry.tool]);
	expect(new ToolCatalog({ ...desktop, connection: "hosted" }, [entry]).tools()).toEqual([]);
});

it.each([
	{ ...desktop, scopes: [] },
	{ ...desktop, features: [] },
])("uses the same policy for discovery and direct calls", async (context) => {
	const catalog = new ToolCatalog(context, [entry]);
	const execute = vi.fn();
	expect(catalog.tools()).toEqual([]);
	await expect(
		catalog.dispatch(entry.tool.name, {}, { credentials: execute }),
	).rejects.toBeInstanceOf(ToolUnavailableError);
	expect(execute).not.toHaveBeenCalled();
});

it("routes by the registered executor, preserves results, and passes cancellation through", async () => {
	const catalog = new ToolCatalog(desktop, [{ ...entry, tool: { name: "a_hosted_looking_name" } }]);
	const result = {
		content: [{ type: "image", data: "fixture" }],
		structuredContent: { ok: true },
		_meta: { private: true },
		isError: true,
	};
	const execute = vi.fn().mockResolvedValue(result);
	const controller = new AbortController();
	expect(
		await catalog.dispatch(
			"a_hosted_looking_name",
			{ value: 1 },
			{ credentials: execute },
			controller.signal,
		),
	).toBe(result);
	expect(execute).toHaveBeenCalledWith(entry.route, { value: 1 }, controller.signal);
	controller.abort();
	await expect(
		catalog.dispatch("a_hosted_looking_name", {}, { credentials: execute }, controller.signal),
	).rejects.toThrow();
	expect(execute).toHaveBeenCalledOnce();
});

it("rejects stale calls after the current catalog removes a tool", async () => {
	const before = new ToolCatalog(desktop, [entry]);
	const after = new ToolCatalog(desktop, [{ ...entry, available: false }]);
	expect(before.tools()).toHaveLength(1);
	await expect(
		after.dispatch(entry.tool.name, {}, { credentials: vi.fn() }),
	).rejects.toBeInstanceOf(ToolUnavailableError);
});

it("rejects collisions rather than silently changing execution location", () => {
	expect(
		() =>
			new ToolCatalog(desktop, [
				entry,
				{ ...entry, id: "other", route: { executor: "hosted", target: "other" } },
			]),
	).toThrow("Conflicting");
	expect(() => new ToolCatalog(desktop, [entry, { ...entry, tool: { name: "alias" } }])).toThrow(
		"Conflicting",
	);
	expect(
		() =>
			new ToolCatalog(desktop, [
				{ ...entry, available: false },
				{ ...entry, id: "hosted" },
			]),
	).toThrow("Conflicting");
});

it("never dispatches a missing executor through an object prototype", async () => {
	const catalog = new ToolCatalog(desktop, [
		{ ...entry, route: { executor: "toString", target: "other" } },
	]);
	await expect(catalog.dispatch(entry.tool.name, {}, {})).rejects.toBeInstanceOf(
		ToolUnavailableError,
	);
});
