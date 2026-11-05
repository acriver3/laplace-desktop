import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scopedToolName } from "@repo/project-protocol/local-mcp";
import { expect, it, vi } from "vitest";

import { desktopYcView, ycConnections, isBundledYcAdapter } from "@repo/local-runtime/yc-ui";
import { ycBrowserIdentity } from "@repo/local-runtime/shared/yc-browser";

const id = "12345678-1234-4234-8234-123456789abc";
const snapshot = {
	applicationId: id,
	title: "Example",
	url: `https://apply.ycombinator.com/apps/${id}/edit`,
	revision: "a".repeat(64),
	answers: { name: "Example" },
	questions: [
		{
			field: "name",
			label: "Company name",
			helpText: "",
			section: "Company",
			order: 0,
			multiline: false,
			editable: true,
			maxLength: 80,
		},
	],
};
function fixture() {
	const available = new Set(["yc-a", "yc-b"]);
	const call = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify(snapshot) }] }));
	const manager = {
		client: vi.fn(),
		listServers: () => [...available].map((id) => ({ id, name: id })),
		getServerConfig: () => ({ identity: ycBrowserIdentity }),
		tools: () =>
			[...available].flatMap((id) =>
				["list_applications", "read_application", "save_draft"].map((tool) => ({
					name: scopedToolName(id, tool, (value) =>
						createHash("sha256").update(value).digest("hex"),
					),
				})),
			),
		call,
	} as unknown as Parameters<typeof desktopYcView>[0];
	return { manager, call, available };
}
const input = { accountId: "desktop", connectionName: "yc-a", applicationId: id };
it("recognizes legacy custom adapters only with the bundled Node and identical shipped code", () => {
	const root = mkdtempSync(join(tmpdir(), "yc-adapter-"));
	try {
		const bundled = join(root, "bundled.cjs");
		const custom = join(root, "custom.cjs");
		writeFileSync(bundled, "trusted adapter");
		writeFileSync(custom, "trusted adapter");
		const config = { transport: "stdio", command: process.execPath, args: [custom] } as Parameters<
			typeof isBundledYcAdapter
		>[0];
		expect(isBundledYcAdapter(config, bundled)).toBe(true);
		expect(
			isBundledYcAdapter({ ...config, command: "another-node" } as typeof config, bundled),
		).toBe(false);
		writeFileSync(custom, "altered adapter");
		expect(isBundledYcAdapter(config, bundled)).toBe(false);
		rmSync(custom);
		expect(isBundledYcAdapter(config, bundled)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
it("requires explicit selection for multiple authorized Desktop connections", async () => {
	const { manager, call } = fixture();
	expect(
		(
			await desktopYcView(
				manager,
				"client",
				"render_yc_application",
				{},
				new AbortController().signal,
			)
		).state,
	).toBe("connections");
	expect(call).not.toHaveBeenCalled();
	await expect(
		desktopYcView(
			manager,
			"client",
			"get_yc_application_view",
			{ ...input, connectionName: "foreign" },
			new AbortController().signal,
		),
	).rejects.toThrow("unavailable");
});
it("stages through preview with the same client and signal, never saving a proposal", async () => {
	const { manager, call } = fixture();
	const changes = [{ field: "name", before: "Example", after: "Proposal" }];
	call.mockResolvedValue({
		content: [{ type: "text", text: JSON.stringify({ ...snapshot, preview: true, changes }) }],
	});
	const signal = new AbortController().signal;
	expect(
		await desktopYcView(
			manager,
			"client",
			"render_yc_application",
			{ ...input, proposedChanges: { name: "Proposal" }, expectedRevision: snapshot.revision },
			signal,
		),
	).toMatchObject({ application: snapshot, changes });
	expect(call).toHaveBeenCalledWith(
		"yc-a",
		"save_draft",
		{
			applicationId: id,
			changes: { name: "Proposal" },
			expectedRevision: snapshot.revision,
			confirm: false,
		},
		signal,
		"client",
	);
});
it("propagates nested failures without replaying a write and rechecks available connections", async () => {
	const { manager, call, available } = fixture();
	call.mockResolvedValue({
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error: { code: "SAVE_UNVERIFIED", message: "Read before retrying." },
				}),
			},
		],
	});
	await expect(
		desktopYcView(
			manager,
			"client",
			"save_yc_draft",
			{ ...input, changes: { name: "Saved" }, expectedRevision: snapshot.revision, confirm: true },
			new AbortController().signal,
		),
	).rejects.toThrow("SAVE_UNVERIFIED");
	expect(call).toHaveBeenCalledOnce();
	available.clear();
	expect(ycConnections(manager, "client")).toEqual([]);
	await expect(
		desktopYcView(
			manager,
			"client",
			"get_yc_application_view",
			input,
			new AbortController().signal,
		),
	).rejects.toThrow("unavailable");
});
