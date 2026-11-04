import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerConfig } from "@repo/local-mcp-core/config";
import { afterEach, expect, it, vi } from "vitest";

import { CatalogInstaller } from "../src/helper/catalog";
import {
	slackBrowserConfig,
	upgradeSlackConfig,
	legacySlackIdentity,
} from "../src/helper/slack-browser-config";
import { SlackBrowserRelay, redactBrowserResult } from "../src/helper/slack-browser-relay";
import { browserExtensionId } from "../src/shared/browser-extension-id";
import { slackBrowserVersion, slackSetupNames } from "../src/shared/slack-browser";
import { approveBrowser } from "./fixtures/browser-approval";

vi.hoisted(() => {
	process.env.LAPLACE_BROWSER_CONNECTION_ENABLED = "true";
});

const relays: SlackBrowserRelay[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(relays.splice(0).map((r) => r.close()));
	await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const identity = { workspace: "https://fixture.slack.com", teamId: "T123456", userId: "U123456" };
async function setup() {
	const relay = new SlackBrowserRelay(identity.workspace);
	relays.push(relay);
	await relay.listen();
	const ticket = relay.pairing();
	const url = new URL(ticket.pairingUrl);
	const post = (
		path: string,
		body: unknown,
		token?: string,
		origin = `chrome-extension://${browserExtensionId}`,
	) =>
		fetch(url.origin + path, {
			method: "POST",
			headers: {
				Origin: origin,
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		});
	return { relay, ticket, url, post, code: url.hash.slice(1) };
}
it("binds one-use approval to the extension origin and requested workspace", async () => {
	const { relay, post, code } = await setup();
	expect((await post("/pair", { code, identity }, undefined, "https://evil.example")).status).toBe(
		403,
	);
	expect(
		(
			await post(
				"/pair",
				{ code, identity },
				undefined,
				"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			)
		).status,
	).toBe(403);
	expect(
		(await post("/pair", { code, identity: { ...identity, workspace: "https://other.slack.com" } }))
			.status,
	).toBe(400);
	expect((await post("/describe", { code })).status).toBe(200);
	const { token } = await (await approveBrowser(relay, post, code, identity)).json();
	expect(token).toBeTruthy();
	expect(relay.status().connected).toBe(true);
	expect((await post("/pair", { code, identity })).status).toBe(400);
	expect((await post("/next", {}, "incorrect")).status).toBe(400);
	await post("/disconnect", {}, token);
	expect(relay.status().connected).toBe(false);
	expect((await post("/next", {}, token)).status).toBe(400);
});
it("accepts an Enterprise identity only for the requested canonical workspace", async () => {
	const { relay, post, code } = await setup();
	const enterprise = { ...identity, teamId: "E123456" };
	expect(
		(
			await post("/pair", {
				code,
				identity: { ...enterprise, workspace: "https://other.slack.com" },
			})
		).status,
	).toBe(400);
	expect((await approveBrowser(relay, post, code, enterprise)).status).toBe(200);
	expect(relay.status().connected).toBe(true);
});
it("dispatches only bounded reads, redacts credentials, and cancels queued work", async () => {
	const { relay, post, code } = await setup();
	await expect(relay.read("channels_list", {})).rejects.toThrow("Approve");
	const { token } = await (await approveBrowser(relay, post, code, identity)).json();
	await expect(relay.read("chat.postMessage", {})).rejects.toThrow("read-only");
	await expect(relay.read("channels_list", { limit: 101 })).rejects.toThrow();
	const result = relay.read("channels_list", { limit: 2 });
	const { request } = await (await post("/next", {}, token)).json();
	expect(request.method).toBe("conversations.list");
	expect(request.args).toEqual({ limit: 2 });
	expect((await (await post("/next", {}, token)).json()).request).toBeNull();
	await post(
		"/result",
		{
			id: request.id,
			ok: true,
			result: { channels: [], token: "never-return", text: "xoxc-fixture" },
		},
		token,
	);
	expect(await result).toEqual({ channels: [], text: "[redacted]" });
	const controller = new AbortController();
	const cancelled = relay.read("channels_list", {}, controller.signal);
	const assertion = expect(cancelled).rejects.toThrow("cancelled");
	controller.abort();
	await assertion;
	expect((await (await post("/next", {}, token)).json()).request).toBeNull();
	const active = relay.read("channels_list", {});
	const rejected = expect(active).rejects.toThrow("approval ended");
	relay.disconnect();
	await rejected;
});
it("expires pairing and approval and rejects late/replayed results", async () => {
	const { relay, post, code } = await setup();
	const clock = vi.spyOn(Date, "now");
	try {
		const now = Date.now();
		clock.mockReturnValue(now + 11 * 60_000);
		expect((await post("/pair", { code, identity })).status).toBe(400);
		clock.mockReturnValue(now);
		const ticket = relay.pairing();
		const { token } = await (
			await approveBrowser(relay, post, new URL(ticket.pairingUrl).hash.slice(1), identity)
		).json();
		clock.mockReturnValue(now + 9 * 60 * 60_000);
		expect(relay.status().connected).toBe(false);
		expect((await post("/next", {}, token)).status).toBe(400);
	} finally {
		clock.mockRestore();
	}
});
it("keeps extension identity stable and never requests cookie or debugger access", async () => {
	const manifest = JSON.parse(
		await readFile(
			new URL("../../../packages/browser-runtime/extension/manifest.json", import.meta.url),
			"utf8",
		),
	);
	const id = createHash("sha256")
		.update(Buffer.from(manifest.key, "base64"))
		.digest("hex")
		.slice(0, 32)
		.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
	expect(id).toBe(browserExtensionId);
	expect(manifest.permissions).not.toContain("cookies");
	expect(manifest.permissions).not.toContain("debugger");
	expect(manifest.host_permissions).toEqual([
		"http://127.0.0.1/*",
		"https://*.slack.com/*",
		"https://*.slack-gov.com/*",
		"https://apply.ycombinator.com/*",
	]);
	expect(manifest.externally_connectable).toBeUndefined();
	expect(
		redactBrowserResult({ authorization: "secret", nested: { cookie: "secret", text: "read" } }),
	).toEqual({ nested: { text: "read" } });
});
it("upgrades only catalog Slack, preserves tool restrictions, and disables old startup", () => {
	const legacy = {
		...slackBrowserConfig(identity.workspace, "/resources", "/node"),
		identity: legacySlackIdentity,
		command: "/old/runtime/node",
		args: [
			"/old/browser/cli.mjs",
			"serve",
			"--workspace",
			identity.workspace,
			"--profile-dir",
			"/keep/profile",
		],
		enabled: true,
		enabledTools: ["channels_list"],
	} as ServerConfig;
	const updated = upgradeSlackConfig(legacy, "/resources", "/node");
	expect(updated.enabled).toBe(false);
	expect(updated.enabledTools).toEqual(["channels_list", ...slackSetupNames]);
	if (updated.transport !== "stdio") throw new Error();
	expect(updated.args).toEqual([
		join("/resources", "helper", "slack-browser.cjs"),
		identity.workspace,
	]);
	expect(updated.env).toEqual({});
	const custom = { ...legacy, identity: undefined };
	expect(upgradeSlackConfig(custom, "/resources", "/node")).toBe(custom);
});
it("installs the shipped adapter without downloading Chromium and exposes cancellable approval", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-browser-test-"));
	directories.push(root);
	let config: ServerConfig | undefined;
	const manager = {
		addServers: vi.fn(async (configs: ServerConfig[]) => {
			config = configs[0];
		}),
		getServerConfig: () => {
			if (!config) throw new Error("Missing");
			return config;
		},
		setEnabled: vi.fn(async (_id: string, enabled: boolean) => {
			config = { ...config!, enabled };
		}),
		restartServer: vi.fn(),
		catalogSetupCall: vi.fn(async (_id: string, tool: string) => ({
			content: [
				{
					text: JSON.stringify(
						tool === "laplace_browser_pair"
							? {
									pairingUrl: "http://127.0.0.1:1234/#" + "a".repeat(43),
									workspace: identity.workspace,
									expiresAt: new Date(Date.now() + 600_000).toISOString(),
								}
							: { connected: false },
					),
				},
			],
		})),
	};
	const download = vi.fn();
	const installer = new CatalogInstaller(manager, {
		root,
		resources: "/resources",
		nodePath: "/node",
		fetch: download,
		browserApprovals: {
			begin: vi.fn(),
			view: () => ({ state: "approval_required", message: "Approve in chat" }),
			cancel: vi.fn(),
		} as any,
	});
	const entry = (await installer.list()).find((c) => c.id === "slack-mcp-server")!;
	expect(entry.fields.map((f) => f.key)).toEqual(["workspace"]);
	expect(entry.version).toBe(slackBrowserVersion);
	const job = await installer.install(
		{ catalogId: entry.id, configuration: { workspace: identity.workspace } },
		{ localOnly: true },
	);
	await vi.waitFor(() =>
		expect(installer.jobs().find((j) => j.id === job.id)?.status).toBe("completed"),
	);
	expect(download).not.toHaveBeenCalled();
	expect(config!.identity).toContain(slackBrowserVersion);
	const auth = await installer.authenticate("slack");
	await vi.waitFor(() =>
		expect(installer.jobs().find((j) => j.id === auth.id)?.stage).toBe("approval_required"),
	);
	expect(installer.jobs().find((j) => j.id === auth.id)?.browserApproval?.workspace).toBe(
		identity.workspace,
	);
	installer.cancel(auth.id);
	await vi.waitFor(() =>
		expect(installer.jobs().find((j) => j.id === auth.id)?.status).toBe("cancelled"),
	);
	expect(config!.enabled).toBe(false);
	expect(installer.jobs().find((j) => j.id === auth.id)?.browserApproval).toBeUndefined();
});
it("does not convert existing catalog metadata to the opt-in browser adapter", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-browser-upgrade-"));
	directories.push(root);
	await writeFile(
		join(root, "catalog-installs.json"),
		JSON.stringify([
			{
				catalogId: "slack-mcp-server",
				serverId: "slack",
				version: "1.1.0-laplace.1",
				directory: join(root, "connectors", "slack-mcp-server", "1.1.0-laplace.1"),
				configuration: { workspace: identity.workspace, profile_dir: "/untouched/profile" },
			},
		]),
	);
	const manager = {
		addServers: vi.fn(),
		getServerConfig: () => ({
			...slackBrowserConfig(identity.workspace, "/resources", "/node"),
			identity: legacySlackIdentity,
		}),
		setEnabled: vi.fn(),
		restartServer: vi.fn(),
		catalogSetupCall: vi.fn(),
	};
	const installer = new CatalogInstaller(manager, {
		root,
		resources: "/resources",
		nodePath: "/node",
	});
	expect((await installer.list()).find((c) => c.id === "slack-mcp-server")?.installed).toBe(false);
	expect(JSON.parse(await readFile(join(root, "catalog-installs.json"), "utf8"))[0].version).toBe(
		"1.1.0-laplace.1",
	);
	expect(manager.addServers).not.toHaveBeenCalled();
});

it("persists independent browser adapter instances without catalog ID collisions", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-browser-instances-"));
	directories.push(root);
	const configs = new Map<string, ServerConfig>();
	const manager = {
		addServers: vi.fn(async (items: ServerConfig[]) => {
			for (const c of items) configs.set(c.id, c);
		}),
		getServerConfig: (id: string) => {
			const c = configs.get(id);
			if (!c) throw new Error("Missing");
			return c;
		},
		setEnabled: vi.fn(),
		restartServer: vi.fn(),
		catalogSetupCall: vi.fn(),
	};
	const options = { root, resources: "/resources", nodePath: "/node", fetch: vi.fn() };
	const installer = new CatalogInstaller(manager, options);
	const ids = [
		"pc_11111111-1111-4111-8111-111111111111",
		"pc_22222222-2222-4222-8222-222222222222",
	];
	for (const serverId of ids) {
		const job = await installer.install({
			catalogId: "slack-mcp-server",
			serverId,
			configuration: { workspace: identity.workspace },
		});
		await vi.waitFor(() =>
			expect(installer.jobs().find((j) => j.id === job.id)?.status).toBe("completed"),
		);
	}
	expect([...configs.keys()]).toEqual(ids);
	expect([...configs.values()].every((c) => !c.enabled)).toBe(true);
	const restarted = new CatalogInstaller(manager, options);
	expect((await restarted.list()).find((c) => c.id === "slack-mcp-server")?.installed).toBe(true);
	for (const id of ids) expect((await restarted.portableSnapshot(id)).sourceId).toBe(id);
	expect(options.fetch).not.toHaveBeenCalled();
});
