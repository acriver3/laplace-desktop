import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { serverConfig } from "@repo/local-mcp-core/config";
import type { EntryFactory } from "@repo/local-mcp-core/store";
import { DesktopManager } from "@repo/local-runtime/manager";
import { bundleCatalog } from "@repo/project-protocol/local-mcp-bundles";
import { afterEach, expect, it, vi } from "vitest";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});
export async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "desktop-manager-test-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const secrets = new Map<string, string>();
	const entries: EntryFactory = async (name) => ({
		getPassword: () => secrets.get(name) ?? null,
		setPassword: (value) => {
			secrets.set(name, value);
		},
		deletePassword: () => {
			secrets.delete(name);
		},
	});
	const installationId = randomUUID();
	let denied = false;
	const requests: Array<{ path: string; body: any }> = [];
	const cloud: any = {
		installationId,
		accountId: "fixture-account",
		desiredVersion: null,
		connections: [],
	};
	const apiFactory = () => ({
		async post(path: any, body: any) {
			requests.push({ path, body });
			if (path === "authorize" && denied) throw new Error("Denied");
			if (path === "discovery") {
				const existing = cloud.connections.find((c: any) => c.localId === body.localId);
				if (existing) existing.catalogRevision = body.revision;
				else
					cloud.connections.push({
						localId: body.localId,
						enabled: body.initialEnabled ?? true,
						toolNames: body.toolNames,
						enabledTools: body.initialEnabledTools ?? body.toolNames,
						reviewedReads: [],
						catalogRevision: body.revision,
						permissionRevision: 1,
						desiredVersion: null,
					});
			}
			if (path === "configuration") return structuredClone(cloud);
			return { authorized: true };
		},
	});
	const manager = new DesktopManager(
		root,
		resolve("resources"),
		"https://connect.fixture.invalid",
		{ entries, apiFactory },
	);
	cleanup.push(() => manager.shutdown());
	await manager.initialize();
	const config = serverConfig.parse({
		id: "fixture",
		name: "Fixture",
		transport: "stdio",
		command: process.execPath,
		args: [resolve("tests/fixtures/connector.mjs")],
		env: { TEST_SECRET: "synthetic-private-secret" },
	});
	const link = async () => {
		await manager.prepareLink("https://connect.fixture.invalid");
		await manager.completeLink({
			origin: "https://connect.fixture.invalid",
			installationId,
			accountId: "fixture-account",
		});
	};
	return {
		root,
		entries,
		apiFactory,
		manager,
		config,
		requests,
		cloud,
		secrets,
		link,
		deny: () => {
			denied = true;
		},
	};
}

it("keeps agent-added servers local in a linked profile and rechecks queued setup authorization", async () => {
	const f = await fixture();
	await f.link();
	await f.manager.addServers([f.config], false, { localOnly: true });
	expect(f.manager.listServers()[0]?.linkMode).toBe("local-only");
	expect(f.requests.some((r) => r.path === "discovery" && r.body.localId === f.config.id)).toBe(
		true,
	);
	const authorize = vi.fn(() => {
		throw new Error("Revoked");
	});
	await expect(
		f.manager.addServers([{ ...f.config, id: "revoked" }], false, { localOnly: true, authorize }),
	).rejects.toThrow("Revoked");
	expect(f.manager.listServers().map((s) => s.id)).toEqual([f.config.id]);
	await expect(f.manager.addServers([f.config], false, { localOnly: true })).rejects.toThrow(
		"already exists",
	);
});
it("runs without login, encrypts launch credentials, and persists a stopped connector", async () => {
	const f = await fixture();
	await f.manager.addServers([f.config], false, { localOnly: false });
	expect(f.manager.status().mode).toBe("local-only");
	expect(
		(await f.manager.call("fixture", "read", {}, new AbortController().signal)).isError,
	).not.toBe(true);
	expect(f.requests).toEqual([]);
	expect(JSON.stringify(f.manager.status())).not.toContain("synthetic-private-secret");
	expect((await readFile(join(f.root, "config.enc"))).toString()).not.toContain(
		"synthetic-private-secret",
	);
	await f.manager.setEnabled("fixture", false);
	await f.manager.refresh();
	expect(f.manager.getServerConfig("fixture").enabled).toBe(false);
	expect(f.manager.status().servers[0]!.status).toBe("stopped");
	await expect(f.manager.call("fixture", "read", {}, new AbortController().signal)).rejects.toThrow(
		"disabled",
	);
});
it("requires fresh linked authorization and keeps explicit server unlink sticky across sign-in", async () => {
	const f = await fixture();
	await f.manager.addServers([f.config], false, { localOnly: false });
	await f.link();
	await f.manager.call("fixture", "read", {}, new AbortController().signal);
	expect(f.requests.filter((r) => r.path === "authorize")).toHaveLength(1);
	expect(JSON.stringify(f.requests)).not.toContain("synthetic-private-secret");
	f.deny();
	await expect(f.manager.call("fixture", "read", {}, new AbortController().signal)).rejects.toThrow(
		"blocked",
	);
	expect(f.manager.status().mode).toBe("linked-blocked");
	expect(f.manager.tools()).toEqual([]);
	await f.manager.setServerLink("fixture", false);
	await f.manager.call("fixture", "read", {}, new AbortController().signal);
	await f.link();
	expect(f.manager.status().servers[0]!.linkMode).toBe("local-only");
	await f.manager.call("fixture", "read", {}, new AbortController().signal);
	expect(f.requests.filter((r) => r.path === "authorize")).toHaveLength(2);
});
it("rejects queued work across a mode change without replaying dispatched work", async () => {
	const f = await fixture();
	const effectFile = join(f.root, "dispatched.txt");
	const releaseFile = join(f.root, "release.txt");
	if (f.config.transport !== "stdio") throw new Error("Expected a stdio fixture");
	await f.manager.addServers(
		[
			{
				...f.config,
				args: [...f.config.args, "--release-file", releaseFile],
				env: { ...f.config.env, EFFECT_FILE: effectFile },
			},
		],
		false,
		{ localOnly: false },
	);
	await f.link();
	const first = f.manager.call("fixture", "read", {}, new AbortController().signal);
	await vi.waitFor(async () => expect(await readFile(effectFile, "utf8")).toBe("read\n"));
	const second = f.manager.call("fixture", "write", {}, new AbortController().signal).then(
		() => "unexpected",
		(error: Error) => error.message,
	);
	await f.manager.setServerLink("fixture", false);
	await writeFile(releaseFile, "release");
	await first;
	expect(await second).toContain("changed");
	expect(await readFile(effectFile, "utf8")).toBe("read\n");
	expect(f.requests.filter((r) => r.path === "authorize")).toHaveLength(1);
});
it("preserves cloud restrictions as local caps on unlink without rewriting configured limits", async () => {
	const f = await fixture();
	await f.manager.addServers([f.config], false, { localOnly: false });
	await f.link();
	f.cloud.connections[0].enabledTools = ["read"];
	await f.manager.refresh();
	await f.manager.unlink();
	expect(f.manager.status().mode).toBe("local-only");
	expect(f.manager.getServerConfig("fixture").enabledTools).toBeUndefined();
	expect(f.manager.status().installationId).toBe(f.cloud.installationId);
	await f.manager.call("fixture", "read", {}, new AbortController().signal);
	await expect(
		f.manager.call("fixture", "write", {}, new AbortController().signal),
	).rejects.toThrow("disabled");
	expect(f.requests.some((r) => r.path === "revoke")).toBe(true);
	await f.manager.setTools("fixture", ["read", "write"]);
	await f.manager.call("fixture", "write", {}, new AbortController().signal);
});
it("limits private catalog setup to pinned identities, exact tools, and empty arguments", async () => {
	const f = await fixture();
	const canvas = bundleCatalog.find((c) => c.recipe === "canvas")!;
	await f.manager.addServers([{ ...f.config, identity: `${canvas.id}@${canvas.version}` }], false, {
		localOnly: false,
	});
	await f.link();
	f.cloud.connections[0].enabled = false;
	await f.manager.refresh();
	await expect(
		f.manager.call("fixture", "canvas_whoami", {}, new AbortController().signal),
	).rejects.toThrow("Cloud permission");
	await f.manager.catalogSetupCall("fixture", "canvas_whoami", {}, new AbortController().signal);
	await expect(
		f.manager.catalogSetupCall("fixture", "write", {}, new AbortController().signal),
	).rejects.toThrow("named setup");
	await expect(
		f.manager.catalogSetupCall(
			"fixture",
			"canvas_whoami",
			{ delay: 0 },
			new AbortController().signal,
		),
	).rejects.toThrow("named setup");
	await f.manager.updateServer("fixture", {
		args: [...(f.config.transport === "stdio" ? f.config.args : []), "changed-launch"],
	});
	await expect(
		f.manager.catalogSetupCall("fixture", "canvas_whoami", {}, new AbortController().signal),
	).rejects.toThrow("named setup");
});

it("keeps signed-out linked tools blocked after a helper restart", async () => {
	const f = await fixture();
	await f.manager.addServers([f.config], false, { localOnly: false });
	await f.link();
	await f.manager.blockLink();
	await f.manager.shutdown();
	const restarted = new DesktopManager(
		f.root,
		resolve("resources"),
		"https://connect.fixture.invalid",
		{ entries: f.entries, apiFactory: f.apiFactory },
	);
	cleanup.push(() => restarted.shutdown());
	await restarted.initialize();
	expect(restarted.status().mode).toBe("linked-blocked");
	expect(restarted.tools()).toEqual([]);
	await expect(restarted.call("fixture", "read", {}, new AbortController().signal)).rejects.toThrow(
		"Cloud permission",
	);
});

it("rechecks a client's local tool ceiling when queued work reaches dispatch", async () => {
	const f = await fixture();
	await f.manager.addServers([f.config], false, { localOnly: false });
	const a = await f.manager.registerClient("Codex"),
		b = await f.manager.registerClient("Claude");
	const read = f.manager.tools().find((tool) => tool.title === "Fixture: read")!;
	const write = f.manager.tools().find((tool) => tool.title === "Fixture: write")!;
	const first = f.manager.callNamed(read.name, { delay: 120 }, new AbortController().signal, b.id);
	await new Promise((resolve) => setTimeout(resolve, 25));
	const queued = f.manager.callNamed(write.name, {}, new AbortController().signal, a.id).then(
		() => "unexpected",
		(error: Error) => error.message,
	);
	await f.manager.setClientTools(a.id, [read.name]);
	await first;
	expect(await queued).toContain("disabled for this AI client");
	expect(f.manager.tools(b.id)).toHaveLength(4);
});

it("preserves local checkbox selections while cloud authorization is unavailable", async () => {
	const f = await fixture();
	await f.manager.addServers([f.config], false, { localOnly: false });
	await f.manager.setTools("fixture", ["read", "write"]);
	await f.link();
	f.cloud.connections[0].enabledTools = ["read"];
	await f.manager.refresh();
	const before = f.manager.listServers()[0]!.tools;
	expect(before.find((tool) => tool.name === "write")).toMatchObject({
		localEnabled: true,
		enabled: false,
	});
	f.deny();
	await expect(f.manager.call("fixture", "read", {}, new AbortController().signal)).rejects.toThrow(
		"blocked",
	);
	const blocked = f.manager.listServers()[0]!.tools;
	expect(blocked.filter((tool) => tool.localEnabled).map((tool) => tool.name)).toEqual([
		"read",
		"write",
	]);
	expect(blocked.every((tool) => !tool.enabled)).toBe(true);
	expect(f.manager.getServerConfig("fixture").enabledTools).toEqual(["read", "write"]);
	await f.manager.unlink();
	expect(
		f.manager
			.listServers()[0]!
			.tools.filter((tool) => tool.localEnabled)
			.map((tool) => tool.name),
	).toEqual(["read"]);
});

it("keeps logout blocked while an already-started link completion drains", async () => {
	const f = await fixture();
	await f.manager.addServers([f.config], false, { localOnly: false });
	await f.link();
	await f.manager.prepareLink("https://connect.fixture.invalid");
	let entered!: () => void, release!: () => void;
	const enteredCredential = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const releaseCredential = new Promise<void>((resolve) => {
		release = resolve;
	});
	const credential = f.manager.store.credential.bind(f.manager.store);
	vi.spyOn(f.manager.store, "credential").mockImplementationOnce(async (value) => {
		entered();
		await releaseCredential;
		return credential(value);
	});
	const completing = f.manager.completeLink({
		origin: "https://connect.fixture.invalid",
		installationId: f.cloud.installationId,
		accountId: f.cloud.accountId,
	});
	await enteredCredential;
	const blocking = f.manager.blockLink();
	expect(f.manager.tools()).toEqual([]);
	const advertisedAfterLogout: number[] = [];
	const off = f.manager.onChanged(() => advertisedAfterLogout.push(f.manager.tools().length));
	release();
	await completing;
	await blocking;
	off();
	expect(advertisedAfterLogout.every((count) => count === 0)).toBe(true);
	expect(f.manager.status().mode).toBe("linked-blocked");
	await f.manager.refresh();
	expect(f.manager.tools()).toEqual([]);
	await expect(
		f.manager.completeLink({
			origin: "https://connect.fixture.invalid",
			installationId: f.cloud.installationId,
			accountId: f.cloud.accountId,
		}),
	).rejects.toThrow("No matching link");
	await f.manager.shutdown();
	const restarted = new DesktopManager(
		f.root,
		resolve("resources"),
		"https://connect.fixture.invalid",
		{ entries: f.entries, apiFactory: f.apiFactory },
	);
	cleanup.push(() => restarted.shutdown());
	await restarted.initialize();
	expect(restarted.status().mode).toBe("linked-blocked");
	expect(restarted.tools()).toEqual([]);
});

it("does not poll while idle and checks revocation on the next call", async () => {
	const intervals = vi.spyOn(globalThis, "setInterval");
	const f = await fixture();
	expect(intervals.mock.calls.some((args) => args[1] === 20_000)).toBe(false);
	intervals.mockRestore();
	await f.manager.addServers([f.config], false, { localOnly: false });
	await f.link();
	const before = f.requests.length;
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
	try {
		await vi.advanceTimersByTimeAsync(180_000);
		expect(f.requests).toHaveLength(before);
	} finally {
		vi.useRealTimers();
	}
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 180_000);
	try {
		await f.manager.call("fixture", "read", {}, new AbortController().signal);
		f.cloud.connections[0].enabledTools = [];
		await expect(
			f.manager.call("fixture", "read", {}, new AbortController().signal),
		).rejects.toThrow();
		expect(f.requests.filter((r) => r.path === "authorize")).toHaveLength(1);
		expect(f.requests.some((r) => r.path === "heartbeat")).toBe(false);
	} finally {
		clock.mockRestore();
	}
});

it("does not notify tool-list changes after an unchanged on-demand refresh", async () => {
	const f = await fixture();
	await f.manager.addServers([f.config], false, { localOnly: false });
	await f.link();
	const changed = vi.fn();
	const unsubscribe = f.manager.onChanged(changed);
	await f.manager.refresh();
	expect(changed).not.toHaveBeenCalled();
	unsubscribe();
});

it("preserves a pinned Slack bundle when refreshing installed connector configurations", async () => {
	const f = await fixture();
	const config = {
		...f.config,
		id: "slack",
		identity: "slack-mcp-server@1.1.0-laplace.1",
		enabled: false,
	};
	await f.manager.addServers([config], false, { localOnly: true });
	await f.manager.refresh();
	expect(f.manager.getServerConfig("slack")).toMatchObject(config);
});
