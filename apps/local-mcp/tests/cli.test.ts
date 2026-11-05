import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli } from "../src/cli";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});
async function harness(
	argv: string[],
	replies: Record<string, unknown[] | ((input: any) => unknown)>,
) {
	const root = await mkdtemp(join(tmpdir(), "cli-test-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const calls: Array<{ method: string; input: unknown }> = [];
	const printed: unknown[] = [];
	const opened: string[] = [];
	await runCli({
		argv: [...argv, "--root", root],
		print: (value) => printed.push(value),
		confirm: async () => false,
		openUrl: (url) => opened.push(url),
		sleep: async () => {},
		request: async (method, input = {}) => {
			calls.push({ method, input });
			const reply = replies[method];
			if (typeof reply === "function") return reply(input);
			if (!reply?.length) throw new Error(`Unexpected ${method}`);
			return reply.shift();
		},
	});
	return { root, calls, printed, opened };
}

it("installs a client through the runtime and replaces the legacy standalone entry", async () => {
	const { root, calls } = await harness(["install-client", "codex", "--confirm"], {
		"client.list": [[]],
		"client.register": [{ id: "6c1c39b4-3c35-4f6b-9b6d-3b0b4b0f1c11", name: "Codex" }],
		"client.preview-install": [
			{ conflict: false, fingerprint: "abc", legacyEntries: ["laplace-local"] },
		],
		"client.install": [{ installed: true }],
	});
	expect(calls.at(-1)).toEqual({
		method: "client.install",
		input: {
			clientId: "6c1c39b4-3c35-4f6b-9b6d-3b0b4b0f1c11",
			client: "codex",
			replace: false,
			fingerprint: "abc",
			removeLegacy: ["laplace-local"],
		},
	});
	// Repeated launches reuse the registration instead of creating another AI client.
	expect(JSON.parse(await readFile(join(root, "cli-clients.json"), "utf8"))).toEqual({
		codex: "6c1c39b4-3c35-4f6b-9b6d-3b0b4b0f1c11",
	});
});

it("links through browser approval and polls until linked", async () => {
	const { calls, opened } = await harness(["login"], {
		"link.start": [
			{
				pending: true,
				verificationUrl: "https://connect.fixture.invalid/local-mcp/link",
				expiresAt: Date.now() + 60_000,
			},
		],
		"link.poll": [{ linked: false }, { linked: true }],
		status: [{ mode: "linked" }],
	});
	expect(opened).toEqual(["https://connect.fixture.invalid/local-mcp/link"]);
	expect(calls.map((call) => call.method)).toEqual([
		"link.start",
		"link.poll",
		"link.poll",
		"status",
	]);
});

it("requires review before changing state", async () => {
	const { calls } = await harness(["remove", "fixture"], {});
	expect(calls).toEqual([]);
	const confirmed = await harness(["remove", "fixture", "--confirm"], {
		"server.remove": [{ removed: true }],
	});
	expect(confirmed.calls).toEqual([{ method: "server.remove", input: { id: "fixture" } }]);
});

it("imports with the reviewed fingerprint and opens headless approvals", async () => {
	const { calls } = await harness(["import", "/tmp/mcp.json", "--select", "a,b", "--confirm"], {
		"import.preview": [{ fingerprint: "f1", servers: [] }],
		"import.apply": [{ added: 2 }],
	});
	expect(calls[1]).toEqual({
		method: "import.apply",
		input: { file: "/tmp/mcp.json", selected: ["a", "b"], fingerprint: "f1" },
	});
	const approvals = await harness(["approvals", "open", "4b8d9a7e-34b1-4f0c-8f5e-2c4b6f6d3a10"], {
		"browser.page": [{ url: "http://127.0.0.1:1/x" }],
	});
	expect(approvals.opened).toEqual(["http://127.0.0.1:1/x"]);
});

it("explains legacy browser migrations instead of running a second manager", async () => {
	await expect(harness(["browser", "migrate", "x"], {})).rejects.toThrow(
		"handled by Laplace Runtime",
	);
});
