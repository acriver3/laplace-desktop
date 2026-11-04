import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { CatalogInstaller } from "../src/helper/catalog";
import { ycBrowserConfig } from "../src/helper/yc-browser-config";
import { YcBrowserRelay, ycActions } from "../src/helper/yc-browser-relay";
import { browserExtensionId } from "../src/shared/browser-extension-id";
import { ycWorkspace } from "../src/shared/yc-browser";
import { approveBrowser } from "./fixtures/browser-approval";

it("installs the Demo Only connector locally without downloads or browser launch", async () => {
	const root = await mkdtemp(join(tmpdir(), "yc-catalog-"));
	const configs = new Map<string, any>();
	const manager = {
		getServerConfig: (id: string) => {
			if (!configs.has(id)) throw Error("missing");
			return configs.get(id);
		},
		addServers: vi.fn(async (items: any[]) => {
			for (const item of items) configs.set(item.id, item);
		}),
		setEnabled: vi.fn(),
		restartServer: vi.fn(),
		catalogSetupCall: vi.fn(),
	};
	const fetch = vi.fn();
	try {
		const catalog = new CatalogInstaller(manager, {
			root,
			resources: root,
			nodePath: process.execPath,
			fetch,
		});
		expect((await catalog.list()).find((e) => e.id === "ycombinator-demo")).toMatchObject({
			demoOnly: true,
			available: true,
			installed: false,
			fields: [],
		});
		const job = await catalog.install({ catalogId: "ycombinator-demo", configuration: {} });
		await vi.waitFor(() => expect(configs.has("ycombinator-demo")).toBe(true));
		expect(configs.get("ycombinator-demo")).toMatchObject({
			transport: "stdio",
			enabled: false,
			args: [join(root, "helper", "yc-browser.cjs")],
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(job.kind).toBe("install");
		await vi.waitFor(() =>
			expect(catalog.jobs().find((j) => j.id === job.id)?.status).toBe("completed"),
		);
		expect((await catalog.list()).find((e) => e.id === "ycombinator-demo")?.installed).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("requires scoped browser approval and never redelivers an uncertain save", async () => {
	const relay = new YcBrowserRelay();
	await relay.listen();
	try {
		await expect(relay.read("list_applications", {})).rejects.toThrow(
			"Approve the Laplace extension",
		);
		const url = new URL(relay.pairing().pairingUrl);
		const post = (path: string, body: unknown, token?: string) =>
			fetch(url.origin + path, {
				method: "POST",
				headers: {
					Origin: `chrome-extension://${browserExtensionId}`,
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			});
		const { token } = await (
			await approveBrowser(relay, post, url.hash.slice(1), {
				workspace: ycWorkspace,
				userId: "demo",
			})
		).json();
		const pending = relay.read("save_draft", {
			applicationId: "12345678-1234-4234-8234-123456789abc",
			expectedRevision: "a".repeat(64),
			changes: { name: "New" },
			confirm: true,
		});
		const outcome = pending.catch((error) => error);
		const { request } = await (await post("/next", {}, token)).json();
		expect(request.method).toBe("application.saveDraft");
		expect(await (await post("/next", {}, token)).json()).toEqual({ request: null });
		await post("/disconnect", {}, token);
		expect(await outcome).toMatchObject({ message: expect.stringContaining("SAVE_UNVERIFIED") });
	} finally {
		await relay.close();
	}
});

it("keeps saves explicit and excludes submission and arbitrary browser commands", () => {
	const config = ycBrowserConfig("/runtime", "/node");
	const parsed = ycActions.save_draft.schema.parse({
		applicationId: "12345678-1234-4234-8234-123456789abc",
		expectedRevision: "a".repeat(64),
		changes: { name: "New" },
	});
	expect(parsed.confirm).toBe(false);
	expect(config.enabledTools).not.toContain("submit_application");
	expect(Object.keys(ycActions)).toEqual(["list_applications", "read_application", "save_draft"]);
});
