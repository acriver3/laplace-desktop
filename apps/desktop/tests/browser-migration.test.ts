import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { browserExtensionId } from "@repo/browser-runtime/browser-extension-id";
import { listBrowserRequests } from "@repo/browser-runtime/browser-requests";
import { serverConfig } from "@repo/local-mcp-core/config";
import { afterEach, expect, it, vi } from "vitest";

import type { CatalogJob } from "../src/helper/catalog";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
	vi.unstubAllEnvs();
	vi.resetModules();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "desktop-browser-migration-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	vi.stubEnv("LAPLACE_TETHERED_BROWSER_V1", "true");
	vi.stubEnv("LAPLACE_DESKTOP_TEST_ROOT", root);
	vi.resetModules();
	const { DesktopManager } = await import("../src/helper/manager");
	const { BrowserApprovals } = await import("../src/helper/browser-approvals");
	const { CatalogInstaller } = await import("../src/helper/catalog");
	const resources = join(root, "resources");
	if (process.platform === "win32") {
		await mkdir(join(resources, "runtimes"), { recursive: true });
		await copyFile(join(process.cwd(), "resources/runtimes/process-host.exe"), join(resources, "runtimes/process-host.exe"));
	}
	await mkdir(join(resources, "helper"), { recursive: true });
	const bytes = gunzipSync(
		await readFile(
			new URL("../../../packages/browser-runtime/assets/outlook-server.cjs.gz", import.meta.url),
		),
	);
	const metadata = JSON.parse(
		await readFile(
			new URL("../../../packages/browser-runtime/assets/outlook.json", import.meta.url),
			"utf8",
		),
	);
	await writeFile(join(resources, "helper/outlook-browser.cjs"), bytes);
	await writeFile(
		join(resources, "browser-connectors.json"),
		JSON.stringify([
			{
				catalogId: "msoutlook-mcp",
				provider: "outlook",
				version: metadata.version,
				serverId: "outlook",
				workspace: "https://outlook.cloud.microsoft",
				file: "helper/outlook-browser.cjs",
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		]),
	);
	const keys = new Map<string, string>();
	const entries = async (key: string) => ({
		getPassword: () => keys.get(key) ?? null,
		setPassword: (value: string) => {
			keys.set(key, value);
		},
		deletePassword: () => {
			keys.delete(key);
		},
	});
	const manager = new DesktopManager(root, resources, "https://connect.fixture.invalid", {
		entries,
	});
	await manager.initialize();
	cleanup.push(() => manager.shutdown());
	const previous = serverConfig.parse({
		id: "personal-mail",
		name: "My mail",
		transport: "stdio",
		command: "node",
		args: ["previous.cjs"],
		env: { SESSION_DIR: join(root, "old-session") },
		enabled: false,
		enabledTools: ["outlook_list_folders"],
	});
	await mkdir(join(root, "old-session"));
	await writeFile(join(root, "old-session", "keep"), "recovery fixture");
	await manager.addServers([previous], false, { localOnly: true });
	const approvals = new BrowserApprovals(manager);
	await approvals.initialize();
	cleanup.push(() => approvals.close());
	const catalog = new CatalogInstaller(manager, {
		root,
		resources,
		nodePath: process.execPath,
		browserApprovals: approvals,
	});
	cleanup.push(async () => {
		for (const job of catalog.jobs()) if (job.status === "running") catalog.cancel(job.id);
		await vi.waitFor(
			() => expect(catalog.jobs().some((job) => job.status === "running")).toBe(false),
			{ timeout: 10000 },
		);
	});
	const migrate = () =>
		catalog.migrateImported(
			{ id: previous.id, catalogId: "msoutlook-mcp", configuration: {}, confirm: true },
			() => {},
		);
	const jobState = (job: CatalogJob) => catalog.jobs().find((value) => value.id === job.id)!;
	return { root, manager, previous, approvals, catalog, migrate, jobState };
}

it("migrates an imported Desktop connection only after fresh consent and the real artifact's read check", async () => {
	const f = await fixture();
	const job = await f.migrate();
	await vi.waitFor(() => expect(f.jobState(job).browserApproval).toBeTruthy(), { timeout: 10000 });
	expect(f.manager.getServerConfig(f.previous.id)).toEqual(f.previous);
	expect((await f.manager.browserMigrationRecords())[0]?.state).toBe("prepared");
	await expect(
		f.manager.catalogSetupCall(f.previous.id, "outlook_send_email", {}, AbortSignal.timeout(1000)),
	).rejects.toThrow();
	const ticket = (await listBrowserRequests(join(f.root, "browser-requests"))).find(
		(value) => value.id === job.id,
	)!;
	const url = new URL(ticket.pairingUrl),
		code = url.hash.slice(1),
		profileId = randomUUID();
	const candidate = {
		id: randomUUID(),
		revision: randomUUID(),
		profileId,
		profileLabel: "Fixture Chrome",
		identity: {
			workspace: "https://outlook.cloud.microsoft",
			userId: "fixture-user",
			tenantId: "fixture-tenant",
			accountId: "fixture-account",
		},
	};
	const post = (path: string, body: unknown, token?: string) =>
		fetch(url.origin + path, {
			method: "POST",
			headers: {
				origin: `chrome-extension://${browserExtensionId}`,
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		});
	expect(
		(
			await post("/review", {
				code,
				profileId,
				profileLabel: "Fixture Chrome",
				candidates: [candidate],
				hint: "discovering",
			})
		).status,
	).toBe(200);
	let capability = "";
	await vi.waitFor(
		() => {
			capability = f.approvals.review(job.id, "desktop").capabilities[candidate.id]!;
			expect(capability).toBeTruthy();
		},
		{ timeout: 5000 },
	);
	await f.approvals.approve(job.id, "desktop", capability);
	const decision = await (await post("/decision", { code, profileId })).json();
	const paired = await (
		await post("/pair", {
			code,
			candidateId: candidate.id,
			identity: candidate.identity,
			authorization: decision.authorization,
		})
	).json();
	let request: { id: string; method: string; args: { path: string } } | undefined;
	await vi.waitFor(
		async () => {
			request = (await (await post("/next", {}, paired.token)).json()).request;
			expect(request).toBeTruthy();
		},
		{ timeout: 5000 },
	);
	expect(request!.method).toBe("owa.get");
	expect(request!.args.path.toLowerCase()).toContain("mailfolders");
	expect(
		(await post("/result", { id: request!.id, ok: true, result: { value: [] } }, paired.token))
			.status,
	).toBe(200);
	await vi.waitFor(() => expect(f.jobState(job).status).toBe("completed"), { timeout: 8000 });
	const migrated = f.manager.getServerConfig(f.previous.id);
	expect(migrated).toMatchObject({
		id: f.previous.id,
		name: f.previous.name,
		generation: f.previous.generation,
		enabledTools: f.previous.enabledTools,
		managedBrowser: { provider: "outlook" },
		enabled: f.previous.enabled,
	});
	expect(f.manager.listServers()).toHaveLength(1);
	expect(await readFile(join(f.root, "old-session", "keep"), "utf8")).toBe("recovery fixture");
	const rollback = await f.catalog.rollbackMigration(f.previous.id, () => {});
	await vi.waitFor(() => expect(f.jobState(rollback).status).toBe("completed"), { timeout: 5000 });
	expect(f.manager.getServerConfig(f.previous.id)).toEqual(f.previous);
}, 20000);

it("cancels before switching and retains the previous configuration and session", async () => {
	const f = await fixture();
	const job = await f.migrate();
	await vi.waitFor(() => expect(f.jobState(job).browserApproval).toBeTruthy(), { timeout: 10000 });
	f.catalog.cancel(job.id);
	await vi.waitFor(() => expect(f.jobState(job).status).toBe("cancelled"), { timeout: 5000 });
	expect(f.manager.getServerConfig(f.previous.id)).toEqual(f.previous);
	expect((await f.manager.browserMigrationRecords())[0]?.state).toBe("cancelled");
	expect(await readFile(join(f.root, "old-session", "keep"), "utf8")).toBe("recovery fixture");
});
