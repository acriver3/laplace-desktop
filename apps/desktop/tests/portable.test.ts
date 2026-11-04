import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EntryFactory } from "@repo/local-mcp-core/store";
import { afterEach, expect, it, vi } from "vitest";

import { CatalogInstaller } from "../src/helper/catalog";
import { DesktopManager } from "../src/helper/manager";
import { PortableConnectors } from "../src/helper/portable";
import { zip } from "./fixtures/bundle";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	for (const stop of cleanup.splice(0).reverse()) await stop();
});
async function desktop() {
	const root = await mkdtemp(join(tmpdir(), "portable-test-"));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
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
	const installationId = randomUUID(),
		cloud = {
			installationId,
			accountId: "account",
			desiredVersion: null,
			connections: [] as any[],
		};
	const fixture = { portableSource: null as any };
	const requests: Array<{ path: string; body: any }> = [];
	const apiFactory = () => ({
		async post(path: any, body: any): Promise<any> {
			requests.push({ path, body });
			if (path === "discovery") {
				let row = cloud.connections.find((c) => c.localId === body.localId);
				if (!row) {
					row = {
						localId: body.localId,
						enabled: body.initialEnabled,
						enabledTools: body.initialEnabledTools,
						reviewedReads: [],
						permissionRevision: 1,
						desiredVersion: null,
					};
					cloud.connections.push(row);
				}
				Object.assign(row, { catalogRevision: body.revision, toolNames: body.toolNames });
			}
			if (path === "configuration") return structuredClone(cloud);
			if (path === "portable-access")
				Object.assign(
					cloud.connections.find((c) => c.localId === body.localId),
					{ enabled: true, enabledTools: body.enabledTools },
				);
			if (path === "portable-source") return fixture.portableSource;
			if (path === "portable-artifact") return { url: "https://artifacts.invalid/test.mcpb" };
			return { authorized: true };
		},
	});
	const manager = new DesktopManager(root, resolve("resources"), "https://fixture.invalid", {
		entries,
		apiFactory,
	});
	cleanup.push(() => manager.shutdown());
	await manager.initialize();
	const catalog = new CatalogInstaller(manager, {
		root,
		resources: manager.resources,
		nodePath: process.execPath,
	});
	const portable = new PortableConnectors(manager, catalog, process.execPath);
	await portable.initialize();
	const link = async () => {
		await manager.prepareLink("https://fixture.invalid");
		await manager.completeLink({
			installationId,
			accountId: "account",
			origin: "https://fixture.invalid",
		});
	};
	return { root, manager, portable, catalog, entries, requests, link, fixture };
}
async function bundle(root: string, required = false, override: Record<string, unknown> = {}) {
	const bytes = zip([
		{
			name: "manifest.json",
			data: JSON.stringify({
				manifest_version: "0.3",
				name: "Fixture",
				version: "1.0.0",
				description: "Synthetic connector",
				author: { name: "Test fixture" },
				server: {
					type: "node",
					mcp_config: {
						command: "node",
						args: ["${__dirname}/server.mjs"],
						env: required ? { TEST_SECRET: "${user_config.secret}" } : {},
					},
				},
				user_config: required
					? { secret: { type: "string", required: true, sensitive: true } }
					: {},
				...override,
			}),
		},
		{ name: "server.mjs", data: await readFile(resolve("tests/fixtures/connector.mjs"), "utf8") },
	]);
	const file = join(root, "fixture.mcpb");
	await writeFile(file, bytes);
	return { file, bytes };
}
async function finished(p: PortableConnectors, id: string) {
	await vi.waitFor(async () => expect((await p.status(id))[0]?.status).not.toBe("running"));
	return (await p.status(id))[0]!;
}

it("persists idempotent installs, gives copies independent identities, and excludes credentials from snapshots", async () => {
	const a = await desktop(),
		b = await desktop(),
		artifact = await bundle(a.root, true);
	const request = {
		bundleFile: artifact.file,
		configuration: { secret: "synthetic-private-auth" },
		idempotencyKey: "first",
	};
	const first = await a.portable.install(request);
	await finished(a.portable, first.id);
	expect((await a.portable.install(request)).id).toBe(first.id);
	await expect(a.portable.install({ ...request, configuration: {} })).rejects.toThrow(
		"Idempotency",
	);
	const second = await a.portable.install({ ...request, idempotencyKey: "second" });
	await finished(a.portable, second.id);
	expect(first.connectorId).not.toBe(second.connectorId);
	const snapshot = a.portable.snapshots()[0]!.snapshot;
	expect(JSON.stringify(snapshot)).not.toContain("synthetic-private-auth");
	expect(JSON.stringify(await a.portable.status())).not.toContain("synthetic-private-auth");
	await a.manager.shutdown(); // No source helper is available during the copy.
	await b.link();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(artifact.bytes)),
	);
	const sourceId = randomUUID();
	b.fixture.portableSource = {
		...snapshot,
		copiedFrom: {
			connectionId: sourceId,
			installationId: randomUUID(),
			localId: first.connectorId,
		},
	};
	const copy = (await b.portable.manage({ action: "copy", sourceId, idempotencyKey: "copy" })) as {
		id: string;
		connectorId: string;
	};
	expect((await finished(b.portable, copy.id)).status).toBe("needs_configuration");
	expect(b.manager.listServers()).toHaveLength(0);
	await b.portable.manage({
		action: "configure",
		id: copy.connectorId,
		configuration: { secret: "fresh-device-auth" },
	});
	const config = b.manager.getServerConfig(copy.connectorId);
	expect(config.transport === "stdio" && config.env.TEST_SECRET).toBe("fresh-device-auth");
	expect(config.transport === "stdio" && config.env.HOME).not.toContain(a.root);
	expect((await b.portable.status(copy.id))[0]?.status).toBe("needs_authentication");
	await b.portable.manage({ action: "verify", id: copy.connectorId });
	expect((await b.portable.status(copy.id))[0]?.status).toBe("ready");
	const restartedA = new DesktopManager(a.root, a.manager.resources, "https://fixture.invalid", {
		entries: a.entries,
	});
	cleanup.push(() => restartedA.shutdown());
	await restartedA.initialize();
	await restartedA.removeServer(first.connectorId);
	expect(b.manager.listServers().find((server) => server.id === copy.connectorId)?.status).toBe(
		"online",
	);
	const restored = new PortableConnectors(b.manager, b.catalog, process.execPath);
	await restored.initialize();
	b.fixture.portableSource = null;
	expect((await restored.copy(sourceId, "copy")).id).toBe(copy.id);
});

it("publishes Keep local metadata but denies remote execution, then enforces hide and explicit remote opt-in", async () => {
	const a = await desktop(),
		artifact = await bundle(a.root);
	const operation = await a.portable.install({
		bundleFile: artifact.file,
		idempotencyKey: "install",
	});
	await finished(a.portable, operation.id);
	await a.manager.setEnabled(operation.connectorId, true);
	await a.link();
	expect(a.manager.accessFor(operation.connectorId)).toEqual({
		visible: true,
		remoteEnabled: false,
	});
	expect(
		a.requests.some((r) => r.path === "discovery" && r.body.localId === operation.connectorId),
	).toBe(true);
	const revision = a.manager.supervisor.states()[0]!.revision!;
	await expect(
		a.manager.remoteCall(operation.connectorId, revision, "read", {}, new AbortController().signal),
	).rejects.toThrow();
	await a.manager.setAccess(operation.connectorId, { visible: true, remoteEnabled: true });
	expect(
		(
			await a.manager.remoteCall(
				operation.connectorId,
				revision,
				"read",
				{},
				new AbortController().signal,
			)
		).isError,
	).not.toBe(true);
	expect(a.requests.some((r) => r.path === "authorize" && r.body.remote === true)).toBe(true);
	await a.manager.setAccess(operation.connectorId, { visible: false, remoteEnabled: false });
	await expect(
		a.manager.remoteCall(operation.connectorId, revision, "read", {}, new AbortController().signal),
	).rejects.toThrow();
	await a.manager.setAccess(operation.connectorId, { visible: true, remoteEnabled: false });
	expect(a.manager.accessFor(operation.connectorId).remoteEnabled).toBe(false);
});

it("keeps successful bulk installs when another bundle fails", async () => {
	const a = await desktop(),
		artifact = await bundle(a.root);
	const results = (await a.portable.manage({
		action: "bulk",
		requests: [
			{ bundleFile: artifact.file, idempotencyKey: "good" },
			{ bundleFile: join(a.root, "missing.mcpb"), idempotencyKey: "bad" },
		],
	})) as Array<{ id: string }>;
	expect((await finished(a.portable, results[0]!.id)).status).toBe("needs_authentication");
	expect((await finished(a.portable, results[1]!.id)).status).toBe("failed");
	expect(a.manager.listServers()).toHaveLength(1);
});

it("retries only failed work, reconciles installed state, and repairs the pinned original bundle", async () => {
	const a = await desktop(),
		file = join(a.root, "fixture.mcpb");
	const op = await a.portable.install({ bundleFile: file, idempotencyKey: "recover" });
	expect((await finished(a.portable, op.id)).status).toBe("failed");
	await bundle(a.root);
	await a.portable.manage({ action: "retry", id: op.id });
	expect((await finished(a.portable, op.id)).status).toBe("needs_authentication");
	expect(a.manager.listServers()).toHaveLength(1);
	await a.portable.manage({ action: "verify", id: op.connectorId });
	await writeFile(
		join(a.root, "instances", op.connectorId, "bundle", "server.mjs"),
		"throw new Error('damaged')",
	);
	await a.portable.manage({ action: "repair", id: op.connectorId });
	expect(a.manager.listServers()[0]?.status).toBe("online");
	expect((await a.portable.status())[0]?.id).toBe(op.id);
});

it("persists local agent management receipts so reconnecting cannot repeat verification", async () => {
	const a = await desktop(),
		artifact = await bundle(a.root);
	const op = await a.portable.install({ bundleFile: artifact.file, idempotencyKey: "setup" });
	await finished(a.portable, op.id);
	const verify = vi.spyOn(a.manager, "setEnabled");
	const request = {
		idempotencyKey: "verification",
		command: { action: "verify", id: op.connectorId },
	};
	const first = await a.portable.manage(request);
	const restored = new PortableConnectors(a.manager, a.catalog, process.execPath);
	await restored.initialize();
	expect(await restored.manage(request)).toEqual(first);
	expect(verify).toHaveBeenCalledTimes(1);
	expect(await restored.remoteStatus((first as { operationId: string }).operationId)).toMatchObject(
		{ status: "completed", items: [{ verified: true }] },
	);
	await expect(
		restored.manage({ ...request, command: { action: "remove", id: op.connectorId } }),
	).rejects.toThrow("Operation changed");
});

it.each([
	{ author: undefined },
	{ manifest_version: "unsupported" },
	{ compatibility: { runtimes: { node: ">=999.0.0" } } },
	{ compatibility: { platforms: [] } },
	{ user_config: { paths: { type: "directory", multiple: true } } },
])("rejects malformed or unsupported custom bundles before launch: %j", async (override) => {
	const a = await desktop(),
		artifact = await bundle(a.root, false, override);
	const op = await a.portable.install({ bundleFile: artifact.file, idempotencyKey: "invalid" });
	expect((await finished(a.portable, op.id)).status).toBe("failed");
	expect(a.manager.listServers()).toHaveLength(0);
});
