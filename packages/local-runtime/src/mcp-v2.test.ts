import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Tool } from "@modelcontextprotocol/server";
import { ToolCatalog } from "@repo/project-protocol/mcp/catalog";
import { SEARCH, EXECUTE } from "@repo/project-protocol/mcp/interface-v2";
import { expect, it, vi } from "vitest";

import type { DesktopManager } from "./manager";
import { desktopV2, desktopHandshake } from "./mcp-v2";
it("allows direct execution, keeps app-only actions private, and deduplicates local writes across sessions", async () => {
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
		const q = await exec(SEARCH, { items: [{ query: "approve" }] });
		expect(JSON.stringify(q.structuredContent)).not.toContain("actionRef");
		const item = {
			connectionName: "desktop",
			actionId: "update",
			arguments: {},
			idempotencyKey: "key",
		};
		const first = await exec(EXECUTE, { items: [item] });
		expect(first.content[0]!.text).not.toContain("private");
		expect(first._meta).toEqual({ capability: "private" });
		expect((await exec(EXECUTE, { items: [item] }, "new")).structuredContent).toMatchObject({
			items: [{ duplicate: true, status: "ok" }],
		});
		const found = await exec(SEARCH, { items: [{ actionId: "update" }] });
		const actionRef = (
			found.structuredContent.items as { result: { items: { actionRef: string }[] } }[]
		)[0]!.result.items[0]!.actionRef;
		await expect(
			exec(EXECUTE, { items: [{ actionRef, idempotencyKey: "x" }] }, "other"),
		).rejects.toThrow("INVALID_ACTION_REF");
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
				[SEARCH, EXECUTE, "edit"].map((name) => ({
					id: name,
					tool: { name, inputSchema: { type: "object" } },
					route: { target: name, executor: name === "edit" ? "local" : "hosted" },
				})),
			);
		const dispatch = vi.fn(
			async (name: string, args: Record<string, unknown>, preflight?: boolean) => {
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
			[EXECUTE, true],
			["edit", false],
			[EXECUTE, false],
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("pages one connection inventory across local and hosted accounts", async () => {
	const manager = {
		supervisor: { states: () => [] },
		client: () => ({}),
	} as unknown as DesktopManager;
	const catalog = () =>
		new ToolCatalog<Tool>(
			{ transport: "http", connection: "desktop" },
			[
				["local", "local"],
				[SEARCH, "hosted"],
			].map(([name, executor]) => ({
				id: name!,
				tool: { name: name!, inputSchema: { type: "object" } },
				route: { executor: executor!, target: name! },
			})),
		);
	const hosted = [{ accountId: "work", connectionName: "tasks", service: "todoist" }];
	const preview = vi.fn(async () => ({ connections: hosted, complete: true }));
	const info = await desktopHandshake(manager, catalog(), preview);
	expect(info).toContain('"connectionName":"desktop"');
	expect(info).toContain('"connectionName":"tasks"');
	expect(preview).toHaveBeenCalledOnce();
	const partial = await desktopHandshake(manager, catalog(), async () => {
		throw Error("offline");
	});
	expect(partial).toContain('"connectionName":"desktop"');
	expect(partial).toContain('"complete":false');
	const call = vi.fn(async (_tool: string, args: Record<string, unknown>) => {
		const q = (args.items as { cursor?: string; limit: number }[])[0]!;
		return {
			structuredContent: {
				items: [
					{
						status: "ok",
						result: {
							accounts: [{ accountId: "work" }],
							connections: {
								items: hosted.slice(Number(q.cursor ?? 0), Number(q.cursor ?? 0) + q.limit),
								complete: true,
							},
						},
					},
				],
			},
		};
	});
	const search = async (cursor?: string, accountId?: string) =>
		(
			await desktopV2(manager, "client", "secret", "transport", catalog, call, SEARCH, {
				items: [{ mode: "connections", limit: 1, cursor, accountId }],
			})
		).structuredContent;
	expect(await search()).toMatchObject({
		items: [
			{
				result: {
					connections: { items: [{ connectionName: "desktop" }], nextCursor: "1", complete: false },
				},
			},
		],
	});
	expect(await search("1")).toMatchObject({
		items: [{ result: { connections: { items: hosted, complete: true } } }],
	});
	expect(await search(undefined, "desktop")).toMatchObject({
		items: [{ result: { accounts: [{ accountId: "desktop" }], connections: { complete: true } } }],
	});
	expect(call).toHaveBeenCalledTimes(2);
});
