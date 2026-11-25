import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Tool } from "@modelcontextprotocol/server";
import { ToolCatalog } from "@repo/project-protocol/mcp/catalog";
import { INIT, SEARCH, EXECUTE } from "@repo/project-protocol/mcp/interface-v2";
import { expect, it, vi } from "vitest";

import type { DesktopManager } from "./manager";
import { desktopV2 } from "./mcp-v2";
it("blocks early calls, keeps app-only actions private, and deduplicates local writes across sessions", async () => {
	const root = await mkdtemp(join(tmpdir(), "desktop-v2-"));
	try {
		const manager = {
			root,
			client: () => ({ id: "client" }),
			supervisor: { states: () => [] },
		} as unknown as DesktopManager;
		const current = () =>
			new ToolCatalog<Tool>(
				{ transport: "http", connection: "desktop" },
				["update", "approve"].map((name) => ({
					id: name,
					tool: {
						name,
						inputSchema: { type: "object", additionalProperties: false },
						...(name === "approve" ? { _meta: { ui: { visibility: ["app"] } } } : {}),
					},
					route: { target: name, executor: "local" },
				})),
			);
		const dispatch = vi.fn(async () => ({
			content: [{ type: "text", text: "ok" }],
			_meta: { capability: "private" },
		}));
		const exec = (name: string, input: Record<string, unknown>, session = "chat") =>
			desktopV2(manager, "client", "secret", session, current, dispatch, name, input);
		await expect(exec(EXECUTE, {})).rejects.toThrow("SESSION_INIT_REQUIRED");
		const { contextId } = (await exec(INIT, {})).structuredContent;
		const q = await exec(SEARCH, { contextId, items: [{ query: "approve" }] });
		expect(JSON.stringify(q.structuredContent)).not.toContain("actionRef");
		const item = {
			connectionName: "desktop",
			actionId: "update",
			arguments: {},
			idempotencyKey: "key",
		};
		const first = await exec(EXECUTE, { contextId, items: [item] });
		expect(first.content[0]!.text).not.toContain("private");
		expect(first._meta).toEqual({ capability: "private" });
		await expect(exec(EXECUTE, { contextId, items: [item] }, "new")).rejects.toThrow(
			"SESSION_INIT_REQUIRED",
		);
		const next = (await exec(INIT, {}, "new")).structuredContent.contextId;
		expect(
			(await exec(EXECUTE, { contextId: next, items: [item] }, "new")).structuredContent,
		).toMatchObject({ items: [{ duplicate: true, status: "ok" }] });
		expect(dispatch).toHaveBeenCalledTimes(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("preflights the hosted subset of a mixed batch before starting local writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "desktop-v2-mixed-"));
	try {
		const manager = {
			root,
			client: () => ({ id: "c" }),
			supervisor: { states: () => [] },
		} as unknown as DesktopManager;
		const catalog = () =>
			new ToolCatalog<Tool>(
				{ transport: "http", connection: "desktop" },
				[INIT, EXECUTE, "edit"].map((name) => ({
					id: name,
					tool: { name, inputSchema: { type: "object" } },
					route: { target: name, executor: name === "edit" ? "local" : "hosted" },
				})),
			);
		const dispatch = vi.fn(
			async (name: string, args: Record<string, unknown>, preflight?: boolean) => {
				if (name === INIT) return { structuredContent: { contextId: "hosted" } };
				if (preflight) return { structuredContent: { items: [{ status: "ok", write: true }] } };
				if (name === EXECUTE)
					return {
						structuredContent: {
							items: [{ status: "user_action_required", receipt: "upstream-receipt" }],
						},
					};
				return { structuredContent: { ok: true } };
			},
		);
		const run = (name: string, input: Record<string, unknown>) =>
			desktopV2(manager, "c", "secret", "chat", catalog, dispatch, name, input);
		const { contextId } = (await run(INIT, {})).structuredContent;
		const local = {
			connectionName: "desktop",
			actionId: "edit",
			arguments: {},
			idempotencyKey: "one",
		};
		const hosted = {
			connectionName: "remote",
			actionId: "provider.write",
			arguments: {},
			idempotencyKey: "two",
		};
		const result = await run(EXECUTE, {
			contextId,
			items: [local, hosted, { ...local, idempotencyKey: "three" }],
		});
		expect(result.structuredContent).toMatchObject({
			items: [
				{ status: "ok" },
				{ status: "user_action_required", receipt: "upstream-receipt" },
				{ status: "skipped" },
			],
		});
		expect(dispatch.mock.calls.map(([name, , preflight]) => [name, !!preflight])).toEqual([
			[INIT, false],
			[EXECUTE, true],
			["edit", false],
			[EXECUTE, false],
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
