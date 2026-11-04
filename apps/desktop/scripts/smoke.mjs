import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { _electron as electron } from "@playwright/test";

import {
	checkFeatureAccess,
	checkSignedOutAccess,
	syntheticAccount,
	syntheticSessionCookie,
} from "./feature-smoke.mjs";
import { checkPoint } from "./point-smoke.mjs";
import { checkProviderPopup } from "./popup-smoke.mjs";
import { testEnvironment } from "./test-environment.mjs";
import { syntheticWebPage } from "./web-shell-smoke.mjs";
import { checkAnonymousConfiguration, checkWorkspace, checkLocalData } from "./workspace-smoke.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultExecutable = join(
	appRoot,
	"out",
	`Laplace-${process.platform}-${process.arch}`,
	...(process.platform === "darwin"
		? ["Laplace.app", "Contents", "MacOS", "Laplace"]
		: ["Laplace.exe"]),
);
const packaged =
	process.argv[2] === "--packaged" ? resolve(process.argv[3] ?? defaultExecutable) : undefined;
if (process.argv.length > 2 && (!packaged || process.argv.length > 4))
	throw new Error("Usage: node scripts/smoke.mjs [--packaged [executable]]");
await access(packaged ?? join(appRoot, "dist/main/index.cjs"));
const testRoot = await mkdtemp(join(tmpdir(), "laplace-desktop-smoke-"));
const profileRoot = join(testRoot, "profiles/local");
const keys = new Set(["config-key", "desktop:key"]);
const clients = [];
let app, upstreamPid, helperPid, endpoint, runtime, invoke;
let step = "start synthetic server";
let failed = false;
let authenticated = false;
let localRouteRequests = 0;
let pendingSignOut;
const setAuthenticated = (value) => {
	authenticated = value;
};
function holdSignOut() {
	let release,
		requested = false;
	const promise = new Promise((resolve) => {
		release = resolve;
	});
	pendingSignOut = {
		promise,
		arrived: () => {
			requested = true;
		},
		release,
	};
	return {
		requested: () => requested,
		release: () => {
			pendingSignOut = undefined;
			release();
		},
	};
}
const mark = (next) => {
	step = next;
	console.log(`Electron smoke: ${step}`);
};
async function bounded(work, label) {
	let timer;
	try {
		return await Promise.race([
			work,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out`)), 20_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const server = createServer((request, response) => {
	response.setHeader("Cache-Control", "no-store");
	if (request.url === "/api/desktop/capabilities") {
		response.setHeader("Content-Type", "application/json");
		response.end(
			JSON.stringify({
				version: 1,
				browserSignIn: false,
				localMcpLinking: false,
				embeddedShellVersion: 1,
				webShellVersion: 1,
				localContentVersion: 1,
			}),
		);
	} else if (request.url === "/api/desktop/accounts") {
		const signedIn =
			authenticated &&
			request.headers.cookie?.includes(`${syntheticSessionCookie}=synthetic-session`);
		response.writeHead(signedIn ? 200 : 401, { "Content-Type": "application/json" });
		response.end(JSON.stringify(signedIn ? syntheticAccount : { error: "Sign in required" }));
	} else if (request.url === "/api/auth/sign-out") {
		const finish = () => {
			authenticated = false;
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ success: true }));
		};
		if (pendingSignOut) {
			pendingSignOut.arrived();
			void pendingSignOut.promise.then(finish);
		} else finish();
	} else if (
		request.url === "/" ||
		request.url.startsWith("/fixture/") ||
		request.url === "/login" ||
		request.url.startsWith("/desktop/local")
	) {
		if (request.url.startsWith("/desktop/local")) localRouteRequests++;
		response.setHeader("Content-Type", "text/html");
		response.end(
			syntheticWebPage.replace(
				"SHELL_HEADER",
				request.headers["x-laplace-desktop-shell"] === "1" ? "1" : "0",
			),
		);
	} else {
		response.writeHead(404);
		response.end();
	}
});
const alive = (pid) => {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function until(check, message, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(message);
}
try {
	// Packaged apps intentionally ignore TEST_ORIGIN. Claim their known local
	// port first; fail if it is occupied rather than contacting a developer server.
	server.listen(packaged ? 3004 : 0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	await writeFile(join(testRoot, "window.json"), JSON.stringify({ profile: "local" }), {
		mode: 0o600,
	});
	mark("launch isolated Electron shell");
	app = await electron.launch({
		...(packaged ? { executablePath: packaged, args: [] } : { args: [appRoot] }),
		env: testEnvironment({
			LAPLACE_DESKTOP_TEST_ROOT: testRoot,
			LAPLACE_DESKTOP_TEST_ORIGIN: origin,
		}),
		timeout: 120_000,
	});
	const page = await app.firstWindow();
	await page.waitForURL("laplace-desktop://app/index.html");
	await page.waitForLoadState("domcontentloaded");
	const location = await app.evaluate(({ app }) => ({
		packaged: app.isPackaged,
		resources: process.resourcesPath,
	}));
	assert.equal(location.packaged, !!packaged);
	const resources = packaged ? join(location.resources, "runtime") : join(appRoot, "resources");
	runtime = join(resources, "runtimes", process.platform === "win32" ? "node.exe" : "node");
	const bridge = packaged
		? join(resources, "helper/bridge.cjs")
		: join(appRoot, "dist/helper/bridge.cjs");
	await access(runtime);
	await access(bridge);
	invoke = (method, input) =>
		bounded(
			page.evaluate(({ method, input }) => window.laplaceDesktop.invoke(method, input), {
				method,
				input,
			}),
			method,
		);
	await until(async () => {
		const state = await invoke("shell.status");
		if (state.helperError) throw new Error(state.helperError);
		try {
			return Boolean((await invoke("status")).endpoint);
		} catch {
			return false;
		}
	}, "Local manager did not become ready");
	const shell = await invoke("shell.status");
	assert.equal(shell.origin, origin);
	assert.equal(shell.account, undefined);
	assert.equal((await invoke("status")).mode, "local-only");
	assert.deepEqual(
		await app.evaluate(({ webContents }) =>
			webContents
				.getAllWebContents()
				.map((contents) => contents.getURL())
				.filter((url) => /^https?:/.test(url)),
		),
		[],
		"Signed-out startup loaded remote web content",
	);
	mark("check the local pages and signed-out feature gates");
	await checkWorkspace(page, app, appRoot, packaged, await invoke("catalog.list"));
	await checkSignedOutAccess(invoke);
	mark("check signed-out Point settings and global shortcut conflicts");
	await checkPoint(page, app, invoke);
	mark("check the full-window Connect shell, local switching, and session expiry");
	// Embedded logout observes the real profile origin, which packaged smoke owns.
	await checkFeatureAccess(
		app,
		invoke,
		until,
		origin,
		setAuthenticated,
		holdSignOut,
		!!packaged,
		() => localRouteRequests,
	);
	mark("check hosted provider popup handoff without opening a browser");
	await checkProviderPopup(app, invoke, until, setAuthenticated);
	helperPid = Number(await readFile(join(profileRoot, "manager.lock"), "utf8"));
	assert.ok(alive(helperPid));
	mark("import and manually add custom MCPs without a Laplace account");
	await checkAnonymousConfiguration(page, app, invoke, appRoot, testRoot);
	await checkLocalData(page, invoke);
	mark("start the synthetic MCP server through trusted IPC");
	await invoke("server.start", { id: "desktop-smoke" });
	await until(
		async () => (await invoke("status")).servers[0]?.status === "online",
		"Fixture MCP server did not become online",
	);
	mark("connect two independently registered AI clients through their stdio bridges");
	const snapshot = await invoke("status");
	endpoint = snapshot.endpoint;
	assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	assert.equal((await fetch(endpoint)).status, 401);
	for (const name of ["Smoke client A", "Smoke client B"]) {
		const registration = await invoke("client.register", { name });
		const key = `client:${registration.id}`;
		keys.add(key);
		const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
		clients.push(client);
		const transport = new StdioClientTransport({
			command: runtime,
			args: [bridge, "--root", profileRoot, "--client-id", registration.id],
			env: testEnvironment(),
			stderr: "pipe",
		});
		transport.stderr?.on("data", () => {});
		await client.connect(transport, { timeout: 15_000 });
	}
	const discovered = (await clients[0].listTools()).tools;
	assert.ok(discovered.some((tool) => tool.name === "local_connectors_install"));
	assert.ok(discovered.some((tool) => tool.name === "local_credential_broker"));
	assert.ok(discovered.some((tool) => tool.name === "local_desktop_manage"));
	const desktopStatus = await clients[0].callTool({
		name: "local_desktop_manage",
		arguments: { action: "status" },
	});
	assert.equal(desktopStatus.structuredContent.mode, "local-only");
	assert.equal(desktopStatus.structuredContent.assistant.hosted, "disconnected");
	assert.ok(
		discovered.some(
			(tool) =>
				tool.name === "local_credentials" &&
				tool.inputSchema.properties.action.enum.includes("run_command"),
		),
	);
	const credentialSetup = await clients[0].callTool({
		name: "local_credentials",
		arguments: { action: "status", requestId: crypto.randomUUID() },
	});
	assert.ok(JSON.stringify(credentialSetup).includes("setupRequired"));
	const denied = await clients[0].callTool({
		name: "local_credentials",
		arguments: { action: "list", requestId: crypto.randomUUID() },
	});
	assert.equal(denied.isError, true);
	const tools = discovered.filter(
		(tool) =>
			!tool.name.startsWith("local_connectors_") &&
			!tool.name.startsWith("local_credential") &&
			tool.name !== "local_desktop_manage",
	);
	assert.equal(tools.length, 4);
	assert.ok(tools.every((tool) => tool.name.startsWith("local_")));
	const pids = [];
	for (const client of clients) {
		const result = await client.callTool({ name: tools[0].name, arguments: {} });
		assert.equal(result.isError, undefined);
		pids.push(JSON.parse(result.content[0].text).pid);
	}
	[upstreamPid] = pids;
	assert.equal(pids[0], pids[1], "AI clients did not share one upstream process");
	assert.ok(alive(upstreamPid));
	mark("check background operation after window close");
	assert.equal((await invoke("shell.status")).mode, "local");
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
	await until(
		async () => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()),
		"Closing the window did not hide it",
	);
	assert.ok(alive(upstreamPid), "Window close stopped the MCP process");
	assert.equal(
		(await clients[1].callTool({ name: tools[0].name, arguments: {} })).isError,
		undefined,
	);
	await app.evaluate(({ app }) => app.emit("activate"));
	await until(
		async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
		"App activation did not restore the window",
	);
	await mkdir(join(appRoot, ".cache"), { recursive: true });
	await page.screenshot({
		path: join(appRoot, packaged ? ".cache/smoke-packaged.png" : ".cache/smoke.png"),
	});
	mark("quit with the window hidden and verify child cleanup");
	for (const client of clients) await client.close();
	const desktopPid = app.process().pid;
	await app.evaluate(({ app, BrowserWindow }) => {
		BrowserWindow.getAllWindows()[0].hide();
		setTimeout(() => app.quit(), 100);
	});
	await until(() => !alive(desktopPid), "Desktop did not exit while its window was hidden");
	app = undefined;
	await until(
		() => !alive(helperPid) && !alive(upstreamPid),
		"Desktop quit left a helper or managed process running",
	);
	assert.equal(
		await fetch(endpoint).then(
			() => true,
			() => false,
		),
		false,
		"Desktop listener survived app quit",
	);
} catch (error) {
	failed = true;
	await app
		?.windows()[0]
		?.screenshot({ path: join(appRoot, ".cache/smoke-failure.png") })
		.catch(() => {});
	// Tests use synthetic data; never dump SDK request objects or keychain values.
	console.error(
		`FAIL Electron smoke during ${step}: ${error instanceof Error ? error.message : "check failed"}`,
	);
} finally {
	pendingSignOut?.release();
	for (const client of clients) await client.close().catch(() => {});
	let inventoryComplete = true;
	if (app && invoke) {
		try {
			for (const client of (await invoke("status")).clients) keys.add(`client:${client.id}`);
		} catch {
			inventoryComplete = false;
			failed = true;
			console.error(
				"FAIL Electron smoke: unable to inventory owned test registrations for cleanup.",
			);
		}
	}
	if (app) await app.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	mark("remove owned temporary keychain entries");
	const journal = join(testRoot, "cleanup.json");
	await writeFile(journal, JSON.stringify({ root: profileRoot, keys: [...keys] }), { mode: 0o600 });
	let cleaned = false;
	try {
		if (runtime)
			await promisify(execFile)(runtime, [join(appRoot, "scripts/keychain-cleanup.mjs"), journal], {
				env: testEnvironment(),
				timeout: 20_000,
			});
		cleaned = true;
	} catch {
		failed = true;
		console.error(
			`FAIL Electron smoke: temporary keychain cleanup failed; nonsecret ownership journal retained at ${journal}`,
		);
	}
	if (alive(helperPid) || alive(upstreamPid)) {
		failed = true;
		console.error("FAIL Electron smoke: an owned test process is still running.");
	}
	if (cleaned && inventoryComplete) await rm(testRoot, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
else
	console.log(
		"PASS Electron: local pages, signed-out catalog and custom import/add/clients, full-window Connect with On this device switching, session expiry, secure provider popup handoff, isolated web view, two stdio clients/one process, hide/restore, quit cleanup, and keychain cleanup.",
	);
