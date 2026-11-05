import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { systemEntry, type EntryFactory } from "@repo/local-mcp-core/store";
import { isLocalConnectorToolName } from "@repo/project-protocol/mcp/local-tools";

import { CatalogInstaller } from "../src/helper/catalog";
import { ConnectorManagement } from "../src/helper/connector-tools";
import { DesktopManager } from "../src/helper/manager";
import { startMcpServer } from "../src/helper/server";

const sleep = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));
function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function expectStopped(pids: number[]) {
	const deadline = Date.now() + 10000;
	while (pids.some(alive) && Date.now() < deadline) await sleep(100);
	assert.ok(
		pids.every((pid) => !alive(pid)),
		"A managed process survived helper shutdown",
	);
}

async function worker(root: string, app: string, resources: string) {
	const entries: EntryFactory = async (name) => {
		process.send?.({ event: "entry", name });
		return systemEntry(root, name);
	};
	const manager = new DesktopManager(root, resources, "https://connect.fixture.invalid", {
		entries,
	});
	await manager.store.doctor();
	await manager.initialize();
	const registered =
		manager.listClients()[0] ?? (await manager.registerClient("Native smoke client"));
	const catalog = new CatalogInstaller(manager, {
		root,
		resources,
		nodePath: process.execPath,
		onChange: () => manager.changed(),
	});
	const server = await startMcpServer(
		manager,
		{
			tools: () => [{ name: "native_write", inputSchema: { type: "object" } }],
			call: async () => {
				// Commit a synthetic write, then lose the entire helper before its response.
				await appendFile(join(root, "effects"), "write\n");
				process.exit(0);
			},
		},
		undefined,
		new ConnectorManagement(manager, catalog),
	);
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		await server.close();
		await manager.shutdown();
		process.disconnect?.();
	};
	process.on("message", (value) => {
		if (value === "shutdown") void stop();
		if (value === "diagnostics") process.send?.({ event: "diagnostics", ...server.diagnostics() });
		if (value === "changed") manager.changed();
	});
	process.once("disconnect", () => void stop());
	process.send?.({ event: "ready", clientId: registered.id });
}

async function smoke(app: string, resources: string, bridge: string, distribution: string) {
	const root = await mkdtemp(join(tmpdir(), "laplace-desktop-native-"));
	const entryNames = new Set<string>();
	const children: ChildProcess[] = [];
	const clients: Client[] = [];
	const transports = new Map<Client, StdioClientTransport>();
	const knownPids = new Set<number>();
	const start = async () => {
		const child = spawn(process.execPath, [process.argv[1]!, "--worker", root, app, resources], {
			cwd: app,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.push(child);
		child.stdout?.resume();
		child.stderr?.resume();
		const clientId = await new Promise<string>((accept, reject) => {
			const timer = setTimeout(() => reject(new Error("Native helper startup timed out")), 30000);
			child.on("message", (message: any) => {
				if (message?.event === "entry") entryNames.add(message.name);
				if (message?.event === "ready") {
					clearTimeout(timer);
					accept(message.clientId);
				}
				if (message?.event === "failed") {
					clearTimeout(timer);
					reject(new Error(message.message));
				}
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				if (code) {
					clearTimeout(timer);
					reject(new Error("Native helper exited before readiness"));
				}
			});
		});
		return { child, clientId };
	};
	const connect = async (clientId: string, modern = false, plugin = false) => {
		const client = new Client(
			{ name: "desktop-native-smoke", version: "1" },
			{ capabilities: {}, versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" } },
		);
		clients.push(client);
		const args = [bridge, "--root", root, "--client-id", clientId];
		const registration = join(root, "plugin-bridge.json");
		if (plugin) await writeFile(registration, JSON.stringify({ command: process.execPath, args }));
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: plugin
				? [
						distribution === "packaged"
							? join(resources, "plugin/scripts/local-bridge.mjs")
							: join(app, "../../plugins/laplace/scripts/local-bridge.mjs"),
					]
				: args,
			...(plugin ? { env: { LAPLACE_PLUGIN_BRIDGE_CONFIG: registration } } : {}),
			stderr: "pipe",
		});
		transport.stderr?.on("data", () => {});
		await client.connect(transport, { timeout: 15000 });
		if (modern) await client.listen({ toolsListChanged: true });
		transports.set(client, transport);
		return client;
	};
	const diagnostics = (child: ChildProcess) =>
		new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				child.off("message", receive);
				reject(Error("Diagnostics timeout"));
			}, 5000);
			const receive = (message: any) => {
				if (message.event === "diagnostics") {
					clearTimeout(timer);
					child.off("message", receive);
					resolve(message);
				}
			};
			child.on("message", receive);
			child.send("diagnostics");
		});
	const baseline = async (child: ChildProcess) => {
		for (let i = 0; i < 50; i++) {
			const state = await diagnostics(child);
			if (!state.activeCalls && !state.activeRequests && !state.subscriptions) return;
			await sleep(100);
		}
		assert.fail("Bridge resources did not return to baseline");
	};
	const read = async (client: Client) => {
		const tools = await client.listTools();
		const providerTools = tools.tools.filter((tool) => isLocalConnectorToolName(tool.name));
		assert.equal(providerTools.length, 1, "Only the granted native connector should be visible");
		const connector = providerTools[0]!;
		const result = await client.callTool(
			{ name: connector.name, arguments: {} },
			{
				timeout: 10000,
			},
		);
		assert.notEqual(result.isError, true);
		const value = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
		assert.equal(value.credentialPresent, true);
		assert.ok(value.pid && value.childPid);
		knownPids.add(value.pid);
		knownPids.add(value.childPid);
		return value as { pid: number; childPid: number };
	};
	try {
		console.log("Native smoke: start helper and verify real keychain storage");
		const first = await start();
		const a = await connect(first.clientId);
		const setupTools = (await a.listTools()).tools;
		assert.ok(setupTools.some((tool) => tool.name === "local_connectors_add_custom"));
		assert.ok(
			setupTools.every((tool) => !isLocalConnectorToolName(tool.name)),
			"A new profile must not expose local providers before installation",
		);
		const setup = await a.callTool({
			name: "local_connectors_add_custom",
			arguments: {
				config: {
					id: "native",
					name: "Native fixture",
					transport: "stdio",
					command: "node",
					args: [join(app, "tests/fixtures/native-connector.mjs")],
					env: { SYNTHETIC_SECRET: "desktop-native-only" },
				},
			},
		});
		assert.notEqual(setup.isError, true);
		assert.equal(JSON.parse((setup.content as Array<{ text: string }>)[0]!.text).saved, true);
		const status = await a.callTool({
			name: "local_connectors_status",
			arguments: { id: "native" },
		});
		assert.notEqual(status.isError, true);
		assert.equal(
			JSON.parse((status.content as Array<{ text: string }>)[0]!.text).installed[0].status,
			"online",
		);
		const initial = await read(a);
		const descriptor = JSON.parse(await readFile(join(root, "endpoint.json"), "utf8"));
		const token = (await systemEntry(root, `client:${first.clientId}`)).getPassword();
		assert.ok(token);
		const direct = new Client({ name: "desktop-http-smoke", version: "1" }, { capabilities: {} });
		clients.push(direct);
		await direct.connect(
			new StreamableHTTPClientTransport(new URL(descriptor.endpoint), {
				requestInit: { headers: { Authorization: `Bearer ${token}` } },
			}),
		);
		assert.deepEqual(
			(await direct.listTools()).tools,
			(await a.listTools()).tools,
			"HTTP and stdio catalogs differ for the same client",
		);
		const directRead = await read(direct);
		assert.deepEqual(directRead, initial, "HTTP and stdio did not share the same local executor");
		await direct.close();
		await a.close();
		assert.ok(
			alive(initial.pid) && alive(initial.childPid),
			"Closing an external client stopped the background connector",
		);
		const b = await connect(first.clientId),
			same = await read(b);
		assert.equal(same.pid, initial.pid);
		await b.close();
		const launched = await connect(first.clientId, false, true);
		assert.equal((await read(launched)).pid, initial.pid);
		await launched.close();
		await baseline(first.child);
		// Abandon the first eight OS processes. The ninth and every subsequent bridge must work.
		console.log("Native smoke: exercise 100 sequential bridge processes");
		for (let attempt = 0; attempt < 100; attempt++) {
			const reconnected = await connect(first.clientId, attempt % 2 === 0);
			assert.equal((await read(reconnected)).pid, initial.pid);
			if (attempt < 8) process.kill(transports.get(reconnected)!.pid!, "SIGKILL");
			else await reconnected.close();
			if ((attempt + 1) % 25 === 0)
				console.log(`Native smoke: ${attempt + 1}/100 reconnects passed`);
		}
		await baseline(first.child);
		console.log("Native smoke: exercise 32 concurrent bridge processes");
		const parallel = await Promise.all(
			Array.from({ length: 32 }, (_, i) => connect(first.clientId, i % 2 === 0)),
		);
		await Promise.all(parallel.map(read));
		assert.equal((await diagnostics(first.child)).subscriptions, 32);
		const notifications = parallel.map(() => 0);
		parallel.forEach((client, i) =>
			client.setNotificationHandler("notifications/tools/list_changed", async () => {
				notifications[i]++;
			}),
		);
		first.child.send("changed");
		for (let i = 0; i < 50 && notifications.some((count) => !count); i++) await sleep(100);
		assert.ok(
			notifications.every((count) => count > 0),
			"Both client generations must receive tool updates",
		);
		await Promise.all(
			parallel.map(async (client, i) => {
				if (i % 2) process.kill(transports.get(client)!.pid!, "SIGKILL");
				else await client.close();
			}),
		);
		await baseline(first.child);
		console.log("Native smoke: verify helper restart and exactly-once effects");
		const survivor = await connect(first.clientId, true);
		await read(survivor);
		let refreshed = 0;
		survivor.setNotificationHandler("notifications/tools/list_changed", async () => {
			refreshed++;
		});
		first.child.send("shutdown");
		await expectStopped([initial.pid, initial.childPid]);
		await new Promise<void>((accept) =>
			first.child.exitCode !== null ? accept() : first.child.once("exit", () => accept()),
		);
		assert.ok(
			!(await readFile(join(root, "config.enc"))).toString().includes("desktop-native-only"),
		);
		const second = await start();
		assert.equal(second.clientId, first.clientId, "Client registration did not persist");
		for (let i = 0; i < 100 && !refreshed; i++) await sleep(100);
		assert.ok(refreshed, "Surviving bridge did not rediscover after helper restart");
		const restored = await read(survivor);
		const uncertain = await survivor.callTool(
			{ name: "native_write", arguments: {} },
			{ timeout: 15000 },
		);
		assert.equal(uncertain.isError, true);
		assert.match(JSON.stringify(uncertain), /outcome.*unknown/i);
		assert.equal(await readFile(join(root, "effects"), "utf8"), "write\n");
		await expectStopped([restored.pid, restored.childPid]);
		const third = await start();
		for (let i = 0; i < 100; i++) {
			try {
				await survivor.listTools({});
				break;
			} catch {
				await sleep(100);
			}
		}
		const afterLoss = await read(survivor);
		assert.equal(
			await readFile(join(root, "effects"), "utf8"),
			"write\n",
			"Uncertain write was replayed",
		);
		await survivor.close();
		third.child.kill("SIGKILL");
		await expectStopped([afterLoss.pid, afterLoss.childPid]);
		console.log(
			JSON.stringify({
				platform: `${process.platform}-${process.arch}`,
				distribution,
				keychain: "passed",
				encryptedRestart: "passed",
				bundledNode: "passed",
				stdioBridge: "passed",
				bundledPluginLauncher: "passed",
				agentConnectorInstallation: "passed",
				repeatedBridgeReconnect: "passed",
				concurrentBridges: 32,
				sequentialBridges: 100,
				forcedBridgeTermination: "passed",
				helperRestart: "passed",
				uncertainWriteExactlyOnce: "passed",
				legacyAndModernNotifications: "passed",
				transportCatalogParity: "passed",
				sharedBackgroundProcess: "passed",
				gracefulCleanup: "passed",
				abruptTreeCleanup: "passed",
			}),
		);
	} finally {
		await Promise.all(clients.map((client) => client.close().catch(() => {})));
		for (const child of children)
			if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
		await sleep(700);
		for (const pid of knownPids)
			if (alive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		for (const name of entryNames)
			try {
				(await systemEntry(root, name)).deletePassword();
			} catch {
				/* An already-removed synthetic entry needs no cleanup. */
			}
		await rm(root, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--worker")
	void worker(process.argv[3]!, process.argv[4]!, process.argv[5]!).catch((error) => {
		process.send?.({
			event: "failed",
			message: error instanceof Error ? error.message : "Native smoke failed",
		});
		process.exitCode = 1;
		process.disconnect?.();
	});
else
	void smoke(process.argv[2]!, process.argv[3]!, process.argv[4]!, process.argv[5]!).catch(
		(error) => {
			console.error(error instanceof Error ? error.message : "Native smoke failed");
			process.exitCode = 1;
		},
	);
