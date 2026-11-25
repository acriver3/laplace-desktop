import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import desktopPackage from "../../desktop/package.json";

const cleanup: string[] = [];
afterEach(async () => {
	for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
function harness(argv: string[], replies: Record<string, any> = {}, confirm = false) {
	const calls: any[] = [],
		printed: any[] = [];
	const request = vi.fn(async (method, input = {}) => {
		calls.push({ method, input });
		if (!(method in replies)) throw Error("Unexpected " + method);
		return typeof replies[method] === "function" ? replies[method](input) : replies[method];
	});
	return {
		calls,
		printed,
		run: () =>
			runCli({
				argv,
				request,
				print: (v) => printed.push(v),
				confirm: async () => confirm,
				sleep: async () => {},
			}),
	};
}
it("routes the previously unreachable npm commands through the shared runtime", async () => {
	const list = harness(["connectors", "versions", "fixture"], { "npm.versions": ["1.0.0"] });
	await list.run();
	expect(list.printed).toEqual([["1.0.0"]]);
	const set = harness(["connectors", "set-version", "fixture", "1.2.3", "--confirm"], {
		"npm.setVersion": {},
	});
	await set.run();
	expect(set.calls[0]).toEqual({
		method: "npm.setVersion",
		input: { id: "fixture", version: "1.2.3" },
	});
	const add = harness(["connectors", "add-npm", "fixture", "@example/mcp", "--confirm"], {
		"npm.add": {},
	});
	await add.run();
	expect(add.calls[0].input).toMatchObject({ package: "@example/mcp", version: "latest" });
});
it("uses durable operations and arbitrary configuration fields for headless installation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "laplace-cli-"));
	cleanup.push(dir);
	const file = join(dir, "config.json");
	await writeFile(file, JSON.stringify({ canvas_url: "https://school.test" }));
	const id = "6c1c39b4-3c35-4f6b-9b6d-3b0b4b0f1c11";
	const h = harness(
		[
			"connectors",
			"install",
			"canvas",
			"--config",
			file,
			"--idempotency-key",
			"reviewed",
			"--confirm",
			"--wait",
		],
		{
			"portable.install": { id, status: "running" },
			"portable.status": [{ id, status: "needs_authentication", connectorId: "pc_fixture" }],
		},
	);
	await h.run();
	expect(h.calls[0].input).toEqual({
		catalogId: "canvas",
		configuration: { canvas_url: "https://school.test" },
		idempotencyKey: "reviewed",
	});
	expect(h.calls[1]).toEqual({ method: "portable.status", input: { id } });
	expect(h.printed[0].status).toBe("needs_authentication");
});
it("keeps browser setup compatible while polling operation IDs", async () => {
	const id = "6c1c39b4-3c35-4f6b-9b6d-3b0b4b0f1c11";
	const h = harness(["browser", "setup", "slack", "--workspace", "team", "--confirm", "--wait"], {
		"catalog.install": { id, status: "running" },
		"portable.status": [{ id, status: "ready" }],
	});
	await h.run();
	expect(h.calls.map((c) => c.method)).toEqual(["catalog.install", "portable.status"]);
});
it("repairs portable connectors rather than merely restarting them", async () => {
	const h = harness(["repair", "fixture", "--confirm"], { "portable.manage": {} });
	await h.run();
	expect(h.calls[0].input).toEqual({ action: "repair", id: "fixture" });
});
it("rejects invalid access before changing state and requires confirmation", async () => {
	const invalid = harness([
		"connectors",
		"access",
		"fixture",
		"--visible",
		"false",
		"--remote",
		"true",
		"--confirm",
	]);
	await expect(invalid.run()).rejects.toThrow();
	expect(invalid.calls).toEqual([]);
	const denied = harness(["connectors", "remove", "fixture"]);
	await denied.run();
	expect(denied.calls).toEqual([]);
	const browser = harness(["browser", "disconnect", "fixture"]);
	await browser.run();
	expect(browser.calls).toEqual([]);
});
it("manages clients with explicit all-versus-none permissions", async () => {
	const id = "6c1c39b4-3c35-4f6b-9b6d-3b0b4b0f1c11";
	for (const [value, expected] of [
		["all", null],
		["none", []],
	] as const) {
		const h = harness(["clients", "permissions", id, "--tools", value, "--confirm"], {
			"client.permissions": {},
		});
		await h.run();
		expect(h.calls[0].input).toEqual({ clientId: id, tools: expected });
	}
});
it("reports operation failure with a failing command and retains the receipt", async () => {
	const id = "6c1c39b4-3c35-4f6b-9b6d-3b0b4b0f1c11";
	const h = harness(["jobs", "wait", id], { "portable.status": [{ id, status: "failed" }] });
	await expect(h.run()).rejects.toThrow("failed");
	expect(h.printed[0].id).toBe(id);
});
it("follows catalog authentication through approval and verification by job ID", async () => {
	const id = "6c1c39b4-3c35-4f6b-9b6d-3b0b4b0f1c11";
	const job = { id, serverId: "pc_fixture", kind: "authenticate", status: "running" };
	const approval = {
		...job,
		stage: "approval",
		browserApproval: { requestId: "approval-request" },
	};
	const waiting = harness(["jobs", "wait", id, "--catalog"], { status: { jobs: [approval] } });
	await waiting.run();
	expect(waiting.calls).toEqual([{ method: "status", input: {} }]);
	expect(waiting.printed[0]).toMatchObject({
		id,
		connectorId: "pc_fixture",
		kind: "authenticate",
		status: "running",
		stage: "approval",
		approvalRequestId: "approval-request",
	});

	const verify = { ...job, kind: "verify", stage: "checking" };
	const done = { ...verify, status: "completed", stage: "verified" };
	const shown = harness(["jobs", "show", id, "--catalog"], { status: { jobs: [done] } });
	await shown.run();
	expect(shown.printed[0]).toMatchObject({ id, kind: "verify", status: "completed" });

	const snapshots = [{ jobs: [verify] }, { jobs: [done] }];
	const resumed = harness(["jobs", "wait", id, "--catalog"], { status: () => snapshots.shift() });
	await resumed.run();
	expect(resumed.printed[0]).toMatchObject({ id, status: "completed" });
});

it("keeps the last operation receipt when waiting times out", async () => {
	const id = "6c1c39b4-3c35-4f6b-9b6d-3b0b4b0f1c11";
	const receipt = { id, connectorId: "pc_fixture", status: "running" };
	const waiting = harness(["jobs", "wait", id, "--timeout", "1"], {
		"portable.status": [receipt],
	});
	const time = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1000);
	try {
		await expect(waiting.run()).rejects.toMatchObject({ receipt });
		expect(waiting.printed).toEqual([]);
	} finally {
		time.mockRestore();
	}
});

it("provides version/help offline without starting the runtime", async () => {
	const h = harness(["--version"]);
	await h.run();
	expect(h.printed).toEqual([desktopPackage.version]);
	expect(h.calls).toEqual([]);
	const help = harness(["connectors", "--help"]);
	await help.run();
	expect(help.printed[0]).toContain("set-version");
});
