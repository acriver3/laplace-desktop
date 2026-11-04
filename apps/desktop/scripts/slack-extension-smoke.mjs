import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "@playwright/test";

// Synthetic Slack only. Never attaches to or reads a real browser profile.
const [adapter, extension, executable, desktop] = process.argv.slice(2);
if (!adapter || !extension || !executable || !desktop || process.platform !== "win32")
	throw new Error(
		"Usage: node slack-extension-smoke.mjs ADAPTER EXTENSION TEST_CHROMIUM PACKAGED_DESKTOP (Windows native host acceptance)",
	);
const root = await mkdtemp(join(tmpdir(), "laplace-extension-smoke-"));
async function until(read, message) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw Error(message);
}
const client = new Client({ name: "extension-fixture", version: "1" }, { capabilities: {} });
let context;
const nativeHost = "com.laplace.browser.test_" + randomUUID().replaceAll("-", "");
const registry = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + nativeHost;
let registered = false;
try {
	const ext = join(root, "extension");
	await cp(resolve(extension), ext, { recursive: true });
	const manifest = JSON.parse(await readFile(join(ext, "manifest.json"), "utf8"));
	// Only synthetic provider traffic is served in this disposable profile.
	manifest.host_permissions.push("https://fixture.slack.com/*");
	await writeFile(join(ext, "manifest.json"), JSON.stringify(manifest));
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [resolve(adapter), "https://fixture.slack.com"],
			stderr: "pipe",
		}),
	);
	const call = async (name, args = {}) => {
		const result = await client.callTool({ name, arguments: args });
		assert.ok(!result.isError, JSON.stringify(result));
		return JSON.parse(result.content[0].text);
	};
	const ticket = await call("laplace_browser_pair");
	const requestId = randomUUID();
	await mkdir(join(root, "browser-requests"));
	await writeFile(
		join(root, "browser-requests", requestId + ".json"),
		JSON.stringify({
			id: requestId,
			provider: "slack",
			environment: "fixture",
			workspace: ticket.workspace,
			pairingUrl: ticket.pairingUrl,
			expiresAt: ticket.expiresAt,
		}),
	);
	const hostManifest = join(root, "native-host.json");
	const publicKey = Buffer.from(manifest.key, "base64");
	const { createHash } = await import("node:crypto");
	const extensionId = createHash("sha256")
		.update(publicKey)
		.digest("hex")
		.slice(0, 32)
		.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
	await writeFile(
		hostManifest,
		JSON.stringify({
			name: nativeHost,
			description: "Disposable native host smoke",
			path: resolve(desktop),
			type: "stdio",
			allowed_origins: ["chrome-extension://" + extensionId + "/"],
		}),
	);
	await promisify(execFile)(
		"reg.exe",
		["add", registry, "/ve", "/t", "REG_SZ", "/d", hostManifest, "/f"],
		{ windowsHide: true },
	);
	registered = true;
	const workerPath = join(ext, "worker.js");
	await writeFile(
		workerPath,
		(await readFile(workerPath, "utf8")).replace("com.laplace.browser", nativeHost),
	);
	context = await chromium.launchPersistentContext(join(root, "profile"), {
		executablePath: resolve(executable),
		env: {
			...process.env,
			ComSpec:
				process.env.ComSpec ||
				process.env.COMSPEC ||
				join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
			LAPLACE_DESKTOP_TEST_ROOT: root,
		},
		headless: true,
		args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
	});
	let providerUser = "U123456";
	const methods = [];
	await context.route("https://fixture.slack.com/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.startsWith("/api/")) {
			const method = url.pathname.slice(5);
			methods.push(method);
			assert.ok(["auth.test", "conversations.list"].includes(method));
			const result =
				method === "auth.test"
					? {
							ok: true,
							team_id: "T123456",
							enterprise_id: "E123456",
							user_id: providerUser,
							url: "https://fixture.slack.com/",
						}
					: {
							ok: true,
							channels: [{ id: "C123456", name: "fixture", token: "must-not-leave-browser" }],
						};
			await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
		} else
			await route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><title>Synthetic Slack</title><h1>Fixture</h1>",
			});
	});
	const profile = await until(
		async () => (await call("laplace_browser_review")).profiles[0],
		"Extension did not discover the pending request",
	);
	assert.ok(
		context.pages().every((page) => !page.url().startsWith("https://fixture.slack.com")),
		"Background discovery must not open a provider tab",
	);
	await call("laplace_browser_focus", { profileId: profile.profileId });
	const tab = await until(
		() => context.pages().find((page) => page.url().startsWith("https://fixture.slack.com")),
		"Explicit Finish signing in did not open the provider tab",
	);
	await tab.goto("https://fixture.slack.com/client/E123456");
	await tab.evaluate(() =>
		localStorage.setItem(
			"localConfig_v2",
			JSON.stringify({ teams: { E123456: { token: "xoxc-synthetic-test-only" } } }),
		),
	);
	const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
	const id = new URL(worker.url()).host;

	const started = Date.now();
	let candidate;
	while (Date.now() - started < 10000) {
		candidate = (await call("laplace_browser_review")).candidates[0];
		if (candidate) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.ok(candidate, "Background discovery did not identify the synthetic account");
	console.log("Background discovery ready in " + (Date.now() - started) + " ms");
	assert.equal(candidate.identity.userId, "U123456");
	assert.equal((await call("laplace_browser_status")).connected, false);
	// An independent minimal MCP Apps host drives the actual bundled approval UI.
	// The real authenticated Desktop MCP routing is exercised in mcp-server.test.ts.
	const host = await context.newPage();
	const widgetSource = await readFile(
		new URL(
			"../../../packages/project-protocol/src/mcp/browser-approval-widget.ts",
			import.meta.url,
		),
		"utf8",
	);
	const html = JSON.parse(
		widgetSource
			.slice(widgetSource.indexOf("export default ") + 15)
			.trim()
			.replace(/;$/, ""),
	);
	const capability = randomUUID();
	let approved = false;
	await host.exposeFunction("approvalTool", async (name, args) => {
		if (name === "local_connectors_browser_approve") {
			assert.equal(args.capability, capability);
			await call("laplace_browser_authorize", {
				candidateId: candidate.id,
				revision: candidate.revision,
			});
			approved = true;
		}
		const status = await call("laplace_browser_status");
		return {
			structuredContent: {
				requestId,
				provider: "Slack",
				workspace: ticket.workspace,
				scopes: ["List channels", "Read conversation history and replies", "Search messages"],
				state: status.connected ? "connected" : approved ? "verifying" : "approval_required",
				message: status.connected
					? "Connected. Your account is ready."
					: "Approve access to this account.",
				candidates: [candidate],
				selectedId: candidate.id,
			},
			_meta: { browserApprovalCapabilities: { [candidate.id]: capability } },
		};
	});
	await host.setContent(
		'<html><title>Agent approval fixture</title><body><iframe title="Laplace approval" style="border:0;width:600px;height:520px"></iframe></body></html>',
	);
	await host.evaluate((html) => {
		const frame = document.querySelector("iframe");
		window.addEventListener("message", async (e) => {
			if (e.source !== frame.contentWindow || !e.data?.id) return;
			const { id, method, params } = e.data;
			let result = {};
			if (method === "ui/initialize") result = { hostContext: { theme: "light" } };
			if (method === "tools/call")
				result = await window.approvalTool(params.name, params.arguments);
			frame.contentWindow.postMessage({ jsonrpc: "2.0", id, result }, "*");
			if (method === "ui/initialize")
				setTimeout(
					async () =>
						frame.contentWindow.postMessage(
							{
								jsonrpc: "2.0",
								method: "ui/notifications/tool-result",
								params: await window.approvalTool("local_connectors_browser_review", {}),
							},
							"*",
						),
					50,
				);
		});
		frame.srcdoc = html;
	}, html);
	await host.bringToFront();
	const card = host.frameLocator("iframe");
	await card.getByRole("button", { name: "Approve connection" }).waitFor();
	if (process.env.LAPLACE_BROWSER_APPROVAL_SCREENSHOT)
		await host.screenshot({ path: process.env.LAPLACE_BROWSER_APPROVAL_SCREENSHOT });
	await card.getByRole("button", { name: "Approve connection" }).click();
	await card.getByRole("heading", { name: "Connected to Slack" }).waitFor({ timeout: 10000 });
	assert.equal((await call("laplace_browser_status")).connected, true);
	assert.ok(
		context.pages().every((page) => !page.url().includes("/panel.html")),
		"Extension popup must stay closed",
	);

	const result = await call("channels_list", { limit: 1 });
	assert.equal(result.channels[0].name, "fixture");
	assert.ok(!JSON.stringify(result).includes("token"));
	const denied = await client.callTool({ name: "chat.postMessage", arguments: {} });
	assert.equal(denied.isError, true);
	await tab.close();
	await until(
		async () => !(await call("laplace_browser_status")).connected,
		"Closing the approved tab did not pause access",
	);
	const renewed = await call("laplace_browser_pair");
	await writeFile(
		join(root, "browser-requests", requestId + ".json"),
		JSON.stringify({
			id: requestId,
			provider: "slack",
			environment: "fixture",
			...renewed,
		}),
	);
	await until(
		async () => (await call("laplace_browser_review")).profiles.length,
		"Extension did not discover the renewed ticket",
	);
	await new Promise((resolve) => setTimeout(resolve, 2200));
	assert.ok(
		context.pages().every((page) => !page.url().startsWith("https://fixture.slack.com")),
		"Renewal and repeated discovery must leave the closed tab closed",
	);
	const reopened = await context.newPage();
	await reopened.goto("https://fixture.slack.com/client/E123456");
	const returning = await until(
		async () => (await call("laplace_browser_review")).candidates[0],
		"Manually reopened tab was not discovered",
	);
	assert.deepEqual(returning.identity, candidate.identity);
	await call("laplace_browser_authorize", {
		candidateId: returning.id,
		revision: returning.revision,
	});
	await until(
		async () => (await call("laplace_browser_status")).connected,
		"Manually reopened tab did not reconnect",
	);
	providerUser = "U654321";
	const changed = await client.callTool({ name: "channels_list", arguments: {} });
	assert.equal(changed.isError, true);
	assert.equal(methods.filter((m) => m === "conversations.list").length, 1);

	console.log(
		"PASS: packaged Desktop native messaging + stdio adapter + real extension worker; passive discovery, explicit sign-in opens a tab, tab closure stays closed across renewal, manual reopen reconnects, in-chat approval, bounded reads and changed-user rejection. Synthetic Slack only.",
	);
} finally {
	await context?.close();
	await client.close();
	if (registered)
		await promisify(execFile)("reg.exe", ["delete", registry, "/f"], { windowsHide: true });
	await rm(root, { recursive: true, force: true });
}
