import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import type { Invocation, Publication } from "@repo/project-protocol/local-mcp";
import { afterEach, expect, it } from "vitest";

import { serverConfig, importMcpConfiguration, minimalEnvironment } from "../src/config";
import { Supervisor } from "../src/supervisor";

const supervisors: Supervisor[] = [],
	roots: string[] = [];
afterEach(async () => {
	for (const supervisor of supervisors.splice(0)) await supervisor.shutdown();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(env: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), "laplace-supervisor-"));
	roots.push(root);
	const publications: Publication[] = [];
	const supervisor = new Supervisor(
		root,
		resolve("../../apps/desktop/resources"),
		() => {},
		async (publication) => {
			publications.push(publication);
		},
		async () => {},
	);
	supervisors.push(supervisor);
	const command =
		process.platform === "win32"
			? resolve("../../apps/desktop/resources/runtimes/node.exe")
			: process.execPath;
	supervisor.configure([
		serverConfig.parse({
			id: "fixture",
			name: "Fixture",
			transport: "stdio",
			command,
			args: [resolve("tests/fixtures/mcp.mjs"), "$(this-is-a-literal-argument)"],
			env,
		}),
	]);
	return { supervisor, publications };
}
function invocation(
	supervisor: Supervisor,
	tool = "read",
	input: Record<string, unknown> = {},
): Invocation {
	return {
		localId: "fixture",
		revision: supervisor.states()[0]!.revision!,
		tool,
		input,
	};
}
it("initializes MCP, discovers paginated tools, injects only local credentials, and spawns literal arguments", async () => {
	const { supervisor, publications } = await setup({
		TEST_CREDENTIAL: "synthetic-private-value",
		PAGINATE: "true",
	});
	await supervisor.start("fixture");
	expect(publications[0]?.toolNames).toEqual(["read", "write"]);
	expect(supervisor.states()[0]?.diagnostic.join("")).not.toContain("synthetic-private-value");
	const result = await supervisor.call(
		invocation(supervisor),
		Date.now() + 1000,
		new AbortController(),
	);
	const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
	expect(data.credentialPresent).toBe(true);
	expect(data.credential).toBe("synthetic-private-value");
	expect(data.operatorToken).toBeUndefined();
	expect(data.argv).toEqual(["$(this-is-a-literal-argument)"]);
});
it("rejects stale revisions and invalid input", async () => {
	const { supervisor } = await setup();
	await supervisor.start("fixture");
	expect(() =>
		supervisor.validate({ ...invocation(supervisor), revision: "a".repeat(64) }),
	).toThrow();
	expect(() => supervisor.validate(invocation(supervisor, "write", {}))).toThrow(
		"Invalid tool arguments",
	);
});
it("serializes calls per server and supports cancellation", async () => {
	const { supervisor } = await setup();
	await supervisor.start("fixture");
	const order: number[] = [];
	const first = supervisor
		.call(invocation(supervisor, "read", { delay: 80 }), Date.now() + 1000, new AbortController())
		.then(() => order.push(1));
	const second = supervisor
		.call(invocation(supervisor), Date.now() + 1000, new AbortController())
		.then(() => order.push(2));
	await Promise.all([first, second]);
	expect(order).toEqual([1, 2]);
	const controller = new AbortController();
	const work = supervisor.call(
		invocation(supervisor, "read", { delay: 500 }),
		Date.now() + 1000,
		controller,
	);
	setTimeout(() => controller.abort(), 20);
	await expect(work).rejects.toThrow();
});
it("stops the complete process group, including a child spawned by an MCP server", async () => {
	const { supervisor } = await setup({ SPAWN_CHILD: "true" });
	await supervisor.start("fixture");
	const result = await supervisor.call(
		invocation(supervisor),
		Date.now() + 1000,
		new AbortController(),
	);
	const childPid = JSON.parse((result.content as Array<{ text: string }>)[0]!.text).childPid;
	expect(childPid).toBeGreaterThan(0);
	await supervisor.stop("fixture");
	// Minimal container init processes may retain terminated children as zombies.
	// Match the guardian test: fail for a running process, not a terminated one.
	let alive = true;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			process.kill(childPid, 0);
			if (
				process.platform === "linux" &&
				/\) Z /.test(await readFile(`/proc/${childPid}/stat`, "utf8"))
			) {
				alive = false;
				break;
			}
		} catch {
			alive = false;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	expect(alive).toBe(false);
});
it("allows three automatic crash restarts in five minutes, then requires manual restart", async () => {
	const { supervisor, publications } = await setup({ CRASH_AFTER_DISCOVERY: "true" });
	await supervisor.start("fixture");
	for (
		let attempt = 0;
		attempt < 140 &&
		(publications.filter((item) => !!item.revision).length < 4 ||
			supervisor.states()[0]!.status !== "needs_attention");
		attempt++
	)
		await new Promise((resolve) => setTimeout(resolve, 50));
	expect(publications.filter((item) => !!item.revision)).toHaveLength(8);
	await expect(supervisor.start("fixture")).rejects.toThrow("Manual restart");
}, 12_000);
it("imports stdio and explicitly configured loopback servers and excludes operator environment", () => {
	const configs = importMcpConfiguration({
		mcpServers: {
			local: {
				command: "/local/server",
				args: ["literal"],
				cwd: "/local/work",
				env: { TOKEN: "local-only" },
			},
			http: { url: "http://127.0.0.1:5555/mcp" },
		},
	});
	expect(configs[0]?.transport).toBe("stdio");
	expect(configs[1]?.transport).toBe("http");
	for (const url of [
		"https://example.com/mcp",
		"http://example.com/mcp",
		"http://127.0.0.1.example.com/mcp",
		"http://user:secret@127.0.0.1/mcp",
	])
		expect(() => importMcpConfiguration({ mcpServers: { bad: { url } } })).toThrow();
	expect(
		minimalEnvironment(
			"/local",
			{},
			{ PATH: "/bin", OPEN_CONNECTOR_ADMIN_TOKEN: "operator", DATABASE_URL: "private" },
		),
	).toEqual({ PATH: "/bin", HOME: "/local" });
});
it("local permission changes produce a new revision and invalidate queued invocations", async () => {
	const { supervisor } = await setup();
	await supervisor.start("fixture");
	const before = invocation(supervisor, "write", { value: "synthetic" });
	await supervisor.permissions("fixture", ["read"]);
	expect(supervisor.states()[0]!.revision).not.toBe(before.revision);
	expect(() => supervisor.validate(before)).toThrow();
	expect(() =>
		supervisor.validate(invocation(supervisor, "write", { value: "synthetic" })),
	).toThrow();
});

it("keeps tool results local and publishes metadata only", async () => {
	const { supervisor, publications } = await setup();
	await supervisor.start("fixture");
	const result = await supervisor.call(
		invocation(supervisor, "write", { value: "synthetic-private-cookie" }),
		Date.now() + 1000,
		new AbortController(),
	);
	expect(JSON.stringify(result)).toContain("synthetic-private-cookie");
	expect(JSON.stringify(publications)).not.toMatch(
		/synthetic-private-cookie|inputSchema|command|env/,
	);
});

it("never replays a stdio write with a lost response and requires explicit repair", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-uncertain-"));
	roots.push(root);
	const file = join(root, "effects.txt");
	const { supervisor } = await setup({ WRITE_EFFECT_FILE: file, EXIT_ON_WRITE: "true" });
	await supervisor.start("fixture");
	await expect(
		supervisor.call(
			invocation(supervisor, "write", { value: "synthetic" }),
			Date.now() + 2000,
			new AbortController(),
		),
	).rejects.toThrow("outcome is unknown");
	await new Promise((resolve) => setTimeout(resolve, 1500));
	expect(await readFile(file, "utf8")).toBe("write\n");
	await expect(supervisor.start("fixture")).rejects.toThrow("Manual restart");
});
