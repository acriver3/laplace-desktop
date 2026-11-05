import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { verifyBrowserConfiguration } from "@repo/local-mcp-core/browser-catalog";
import {
	ConnectorUpdates,
	type ConnectorUpdateStatus,
} from "@repo/local-mcp-core/connector-updates";
import { retainRuntime } from "@repo/local-mcp-core/retained-runtime";
import {
	UpdateCoordination,
	sharedBrowserUpdateRoot,
} from "@repo/local-mcp-core/update-coordination";
import {
	automaticUpdatesEnabled,
	UpdatePolicyStore,
	updateInstanceKey,
} from "@repo/local-mcp-core/update-policy";
import { z } from "zod";

import desktopPackage from "../../package.json";
import { credentialBrokeringEnabled } from "../shared/credential-broker-feature";
import { credentialMessages } from "../shared/credential-setup";
import {
	helperInputs,
	helperRequest,
	type HelperEvent,
	type HelperReply,
} from "../shared/helper-contracts";
import { desktopBrokerAdapter } from "./broker-adapter";
import { BrowserApprovals } from "./browser-approvals";
import { CatalogInstaller } from "./catalog";
import {
	previewClientRegistration,
	registerClient,
	configurePluginBridge,
} from "./client-registration";
import { ConnectionBroker } from "./connection-broker";
import { ConnectorManagement } from "./connector-tools";
import { CredentialSetupError } from "./credential-errors";
import { CredentialBroker } from "./credentials";
import { startCredentialRelay } from "./credentials-relay";
import { HostedConnections } from "./hosted-oauth";
import {
	previewImportFile,
	importSelectedFile,
	normalizeManualConfiguration,
	previewManualConfiguration,
} from "./imports";
import { DesktopManager } from "./manager";
import { previewLegacyMigration, migrateSelectedLegacy } from "./migration";
import { PortableConnectors } from "./portable";
import { startPortableRelay } from "./portable-relay";
import { startMcpServer } from "./server";
import { stableBridge } from "./stable-bridge";

async function acquireLock(root: string) {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const path = join(root, "manager.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(path, "wx", 0o600);
			await handle.writeFile(String(process.pid));
			return async () => {
				await handle.close();
				await rm(path, { force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const pid = Number(await readFile(path, "utf8"));
			if (!Number.isSafeInteger(pid) || pid < 1)
				throw new Error("Invalid manager lock; check the desktop state directory");
			try {
				process.kill(pid, 0);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
					await rm(path, { force: true });
					continue;
				}
				throw cause;
			}
			throw new Error("Another Laplace Desktop manager is running for this profile");
		}
	}
	throw new Error("Unable to acquire desktop manager lock");
}
export async function startHelper() {
	if (!process.send || !process.connected)
		throw new Error("The desktop helper must be launched by Laplace Desktop");
	const root = resolve(z.string().min(1).parse(process.env.LAPLACE_DESKTOP_ROOT));
	const resources = resolve(z.string().min(1).parse(process.env.LAPLACE_DESKTOP_RESOURCES));
	const origin = process.env.LAPLACE_DESKTOP_ORIGIN ?? "https://connect.withlaplace.com";
	const release = await acquireLock(root);
	const send = (message: HelperEvent | HelperReply) => {
		if (process.connected) process.send?.(message, () => {});
	};
	const manager = new DesktopManager(root, resources, origin);
	const bridgeRegistration = await stableBridge(
		root,
		process.execPath,
		join(dirname(process.argv[1]!), "bridge.cjs"),
	);
	const credentials = new CredentialBroker(
		root,
		resources,
		() => manager.changed(),
		manager.entries,
	);
	manager.credentialRequests = () => credentials.snapshot().pending.length;
	const hosted = new HostedConnections(manager, (url) => send({ event: "open-url", url }));
	const browserApprovals = new BrowserApprovals(manager);
	const catalog = new CatalogInstaller(manager, {
		notificationOwner: () => {
			const snapshot = manager.status();
			return snapshot.mode === "linked" && snapshot.accountId && snapshot.installationId
				? {
						accountId: snapshot.accountId,
						installationId: snapshot.installationId,
						origin: snapshot.origin,
					}
				: undefined;
		},
		browserApprovals,
		root,
		resources,
		nodePath: process.execPath,
		origin,
		onChange: () => manager.changed(),
	});
	manager.jobs = () => catalog.jobs();
	const portable = new PortableConnectors(manager, catalog, process.execPath);
	const connectionBroker = new ConnectionBroker(
		root,
		desktopBrokerAdapter(
			manager,
			credentials,
			catalog,
			portable,
			(section) => send(section ? { event: "desktop-open", section } : { event: "broker-focus" }),
			(sessionId) => send({ event: "broker-unlock", sessionId }),
			async (principal, session) => {
				try {
					const description = (await (
						await manager.credentialRelayApi()
					).post("broker", { action: "describe", sessionId: session.id })) as {
						targets: unknown[];
					};
					if (
						JSON.stringify(description.targets) ===
						JSON.stringify(session.items.map((i) => i.target))
					)
						return;
				} catch {}
				const result = (await hosted.call(
					principal.id.replace(/^local:/, ""),
					"credential_broker_prepare",
					{
						requestId: session.id,
						accountId: session.accountId,
						installationId: session.installationId,
						command: {
							action: "start",
							sessionId: session.id,
							targets: session.items.map((i) => i.target),
						},
					},
					AbortSignal.timeout(10000),
				)) as { isError?: boolean };
				if (result.isError) throw Error("Hosted management authorization required.");
			},
		),
		() => manager.changed(),
		manager.entries,
	);
	credentials.connectionBroker = connectionBroker;
	manager.credentialRequests = () =>
		credentials.snapshot().pending.length + connectionBroker.pendingCount();
	let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
	manager.onChanged(() => {
		if (snapshotTimer) return;
		snapshotTimer = setTimeout(() => {
			snapshotTimer = undefined;
			send({ event: "snapshot", data: manager.status() });
		}, 100);
	});
	let server: Awaited<ReturnType<typeof startMcpServer>>;
	try {
		await manager.initialize(false);
		await portable.initialize();
		await credentials.initialize();
		await connectionBroker.initialize();
		await browserApprovals.initialize();
		server = await startMcpServer(
			manager,
			hosted,
			credentials,
			new ConnectorManagement(manager, catalog, portable, browserApprovals, (requestId) =>
				send({ event: "browser-approval", requestId }),
			),
			(section) => send({ event: "desktop-open", section }),
		);
	} catch (error) {
		credentials.close();
		await connectionBroker.shutdown();
		await browserApprovals.close();
		await hosted.shutdown();
		await manager.shutdown();
		await release();
		throw error;
	}
	let closing = false;
	const stopCredentialRelay = startCredentialRelay(manager, credentials);
	const stopPortableRelay = startPortableRelay(manager, portable);
	void credentials.initializeConnection().catch(() => {});
	const stop = async () => {
		if (closing) return;
		closing = true;
		stopCredentialRelay();
		stopPortableRelay();
		credentials.close();
		await connectionBroker.shutdown();
		clearInterval(parentWatch);
		if (snapshotTimer) clearTimeout(snapshotTimer);
		for (const job of catalog.jobs())
			if (job.status === "running")
				try {
					catalog.cancel(job.id);
				} catch {}
		connectorUpdates.cancel();
		await sharedUpdates.stop();
		await server.close();
		await hosted.shutdown();
		await manager.shutdown();
		await release();
		if (process.connected) process.disconnect?.();
	};
	const parent = process.ppid;
	const parentWatch = setInterval(() => {
		try {
			process.kill(parent, 0);
			if (process.ppid !== parent) void stop();
		} catch {
			void stop();
		}
	}, 1000);
	parentWatch.unref();
	process.once("disconnect", () => void stop());
	process.once("SIGTERM", () => void stop());
	process.once("SIGINT", () => void stop());
	let updateRelease: (() => void) | undefined;
	let activeHelperRequests = 0;
	let deviceBusy = true;
	let recoverPending = true;
	const updateBusy = () =>
		deviceBusy ||
		activeHelperRequests > 0 ||
		(manager.mcpDiagnostics()?.activeCalls ?? 0) > 0 ||
		manager.supervisor.activity() ||
		manager.credentialRequests() > 0 ||
		catalog.jobs().some((job) => job.status === "running") ||
		browserApprovals
			.list()
			.some((item) => !["approved", "cancelled", "expired", "error"].includes(item.state));
	const sharedUpdates = new UpdateCoordination(
		sharedBrowserUpdateRoot(),
		updateBusy,
		() => manager.supervisor.tryMaintenance(),
		async () => {},
	);
	await sharedUpdates.start();
	manager.updateMaintenance = () => sharedUpdates.active;
	const connectorUpdates = new ConnectorUpdates({
		root,
		version: desktopPackage.version,
		kind: "desktop",
		entries: manager.entries,
		configurations: async () => (await manager.store.read()).servers,
		replace: (config, expected) => manager.replaceManagedUpdate(config, expected),
		verify: async (id) => {
			if (manager.supervisor.states().find((s) => s.id === id)?.status !== "online")
				throw Error("Updated connector did not start");
		},
		maintenance: async (id) =>
			sharedUpdates.acquire(() => manager.supervisor.tryConnectorMaintenance(id)),
		busy: updateBusy,
		toolNames: (id) =>
			manager.supervisor
				.states()
				.find((s) => s.id === id)
				?.tools.map((t) => t.name) ?? [],
	});
	catalog.updateResolver = async (id) => {
		const installed = await connectorUpdates.installed(id);
		if (installed) return installed;
		try {
			const config = manager.getServerConfig(id);
			if (!config.managedBrowser || config.transport !== "stdio") return;
			const receipt = await verifyBrowserConfiguration(resources, config);
			return {
				catalogId: receipt.catalogId,
				version: receipt.runtimeVersion,
				mode: "tethered" as const,
				directory: dirname(config.args[0]!),
			};
		} catch {
			return;
		}
	};
	const connectorStatus = async () => {
		const rows: ConnectorUpdateStatus[] = await connectorUpdates.status();
		const policy = await new UpdatePolicyStore().read();
		for (const entry of await catalog.list()) {
			if (!entry.installed || !entry.serverId || rows.some((row) => row.id === entry.serverId))
				continue;
			try {
				const enrollment = await catalog.updateEnrollment(entry.serverId);
				const config = manager.getServerConfig(entry.serverId);
				rows.push({
					id: config.id,
					name: config.name,
					version: enrollment.version,
					pinned: !!policy.pins[updateInstanceKey(root, config.id)],
					message: "Check the connector catalog to verify update eligibility.",
				});
			} catch {
				/* Imports remain unmanaged. */
			}
		}
		return rows;
	};
	void connectorUpdates.recover().catch(() => {});
	process.on("message", (raw: unknown) => {
		void (async () => {
			const parsed = helperRequest.safeParse(raw);
			if (!parsed.success) return;
			const request = parsed.data;
			const counted = !request.method.startsWith("updates.") && request.method !== "status";
			if (counted) activeHelperRequests++;
			try {
				const input: any = helperInputs[request.method].parse(request.input);
				if (closing && request.method !== "shutdown")
					throw new Error("Laplace Desktop is stopping");
				if (
					(updateRelease || sharedUpdates.active) &&
					![
						"updates.activity",
						"updates.deviceActivity",
						"updates.release",
						"shutdown",
						"status",
					].includes(request.method)
				)
					throw new Error("Update maintenance in progress; retry shortly.");
				let result: unknown;
				switch (request.method) {
					case "updates.retain":
						if (updateBusy())
							throw Error("Local work is active; retry the update when it finishes.");
						for (const config of (await manager.store.read()).servers) {
							if (!config.managedBrowser) continue;
							const release = manager.supervisor.tryConnectorMaintenance(config.id);
							if (!release) throw Error("Connector is busy; retry the update shortly.");
							try {
								await verifyBrowserConfiguration(resources, config);
								const retained = await retainRuntime(root, resources, config, manager.entries);
								if (retained !== config) {
									await manager.replaceManagedUpdate(retained);
									await connectorUpdates.relocate(config.id, retained);
								}
							} finally {
								release();
							}
						}
						result = true;
						break;
					case "updates.cancelConnector":
						connectorUpdates.cancel(input.id);
						result = await connectorStatus();
						break;
					case "updates.connectors":
						result = await connectorStatus();
						break;
					case "updates.checkConnectors":
						result = await connectorUpdates.check();
						for (const entry of await catalog.list()) {
							if (
								!entry.serverId ||
								!entry.installed ||
								(await connectorUpdates.status()).some((row) => row.id === entry.serverId)
							)
								continue;
							try {
								const e = await catalog.updateEnrollment(entry.serverId);
								await connectorUpdates.enroll(e.id, e.directory, e.catalogId, e.version, e.mode);
							} catch {
								/* Unverifiable legacy entries remain unmanaged. */
							}
						}
						result = await connectorStatus();
						break;
					case "updates.prepareConnectors":
						if (automaticUpdatesEnabled())
							for (const row of await connectorUpdates.status())
								if (row.availableVersion && !row.pinned && !row.message)
									await connectorUpdates.prepare(row.id, undefined, true);
						result = true;
						break;
					case "updates.automaticConnectors":
						if (automaticUpdatesEnabled())
							for (const row of await connectorUpdates.status())
								if (row.availableVersion && !row.pinned && !row.message)
									await connectorUpdates.apply(row.id, true);
						result = true;
						break;
					case "updates.pin":
						await connectorUpdates.pin(input.id, input.pinned);
						result = await connectorStatus();
						break;
					case "updates.enroll": {
						const e = await catalog.updateEnrollment(input.id);
						await connectorUpdates.enroll(e.id, e.directory, e.catalogId, e.version, e.mode);
						await connectorUpdates.apply(e.id, false, undefined, true);
						result = await connectorStatus();
						break;
					}
					case "updates.applyConnector":
						if (input.automatic && !automaticUpdatesEnabled())
							throw Error("Automatic connector updates are not activated");
						if (!input.automatic) await connectorUpdates.recover();
						await connectorUpdates.apply(input.id, input.automatic);
						result = await connectorStatus();
						break;
					case "updates.deviceActivity":
						if (input.busy && sharedUpdates.active)
							throw Error(
								"Update maintenance is active; operation was not started. Retry shortly.",
							);
						deviceBusy = input.busy;
						if (!deviceBusy && recoverPending) {
							await connectorUpdates.recover();
							recoverPending = false;
						}
						result = true;
						break;
					case "updates.activity":
						result = { busy: updateBusy() };
						break;
					case "updates.acquire":
						if (updateRelease || updateBusy()) {
							result = false;
							break;
						}
						updateRelease = await sharedUpdates.acquire(() => manager.supervisor.tryMaintenance());
						result = !!updateRelease;
						break;
					case "updates.release":
						updateRelease?.();
						updateRelease = undefined;
						result = true;
						break;
					case "broker.authorizeAssistant":
						result = await connectionBroker.authorizeAssistant(input.principalId, (p) =>
							credentials.authorizeBrokerAssistant(p),
						);
						break;
					case "credentials.chromeCheck":
						await credentials.brokerChrome.open(
							"https://connect.withlaplace.com",
							[],
							AbortSignal.timeout(15000),
							true,
						);
						result = { opened: true };
						break;
					case "credentials.chromeStatus":
						result = credentials.brokerChrome.readiness();
						break;
					case "broker.stage": {
						const client = manager.client(input.clientId);
						result = await connectionBroker.call(
							{
								id: "local:" + client.id,
								name: client.name,
								hosted: false,
								authorize: () => {
									manager.client(input.clientId);
									if (!manager.clientToolAllowed(input.clientId, "local_credentials"))
										throw Error("Enable credential requests for this assistant.");
								},
							},
							{ action: "start", sessionId: input.sessionId, targets: input.targets },
							input.sessionId,
						);
						break;
					}
					case "broker.enabled":
						result = {
							enabled: credentialBrokeringEnabled(),
							accountId: manager.status().accountId,
							installationId: manager.status().installationId,
						};
						break;
					case "broker.list":
						result = connectionBroker.list();
						break;
					case "broker.call": {
						const id = input.principalId as string;
						result = await connectionBroker.callFromDesktop(id, input.command, input.requestId);
						break;
					}
					case "credentials.status":
						result = await credentials.connectionStatus();
						break;
					case "credentials.save":
						result = await credentials.configure(input.settings, true);
						break;
					case "credentials.prepare":
						result = await credentials.prepareConnection(input.server);
						break;
					case "credentials.signIn":
						result = await credentials.signIn(input);
						break;
					case "credentials.answer":
						credentials.connection.answer(input.value);
						result = credentials.snapshot();
						break;
					case "credentials.cancel":
						credentials.lock();
						result = credentials.snapshot();
						break;
					case "credentials.disconnect":
						result = await credentials.disconnectConnection();
						break;
					case "credentials.browsers":
						result = await credentials.browser.discover();
						break;
					case "credentials.browserSelect":
						result = await credentials.selectBrowser(input.id, input.launch);
						break;
					case "credentials.browserClose":
						await credentials.browser.close();
						result = credentials.snapshot();
						break;
					case "credentials.configure":
						result = await credentials.configure(input.settings);
						break;
					case "credentials.unlock":
						result = await credentials.unlock(input.password);
						break;
					case "credentials.lock":
						credentials.lock();
						result = { locked: true };
						break;
					case "credentials.items":
						result = await credentials.items();
						break;
					case "credentials.approve":
						result = await credentials.approve(
							input.principalId,
							input.id,
							input.allow,
							input.remember,
						);
						break;
					case "status":
						result = manager.status();
						break;
					case "server.add":
						result = await manager.addServers([normalizeManualConfiguration(input.config)]);
						break;
					case "server.preview":
						result = await previewManualConfiguration(
							input.config,
							{ root, resources },
							input.id ? manager.getServerConfig(input.id) : undefined,
						);
						break;
					case "server.update":
						result = await manager.updateServer(input.id, input.config);
						break;
					case "server.remove":
						result = await manager.removeServer(input.id);
						break;
					case "server.start":
						result = await manager.setEnabled(input.id, true);
						break;
					case "server.stop":
						result = await manager.setEnabled(input.id, false);
						break;
					case "server.restart":
						result = await manager.restartServer(input.id);
						break;
					case "server.permissions":
						result = await manager.setTools(input.id, input.tools);
						break;
					case "server.link":
						result = await manager.setServerLink(input.id, input.linked);
						break;
					case "import.preview":
						result = await previewImportFile(input.file, { root, resources });
						break;
					case "import.apply":
						result = await manager.addServers(
							await importSelectedFile(input.file, input.selected, input.fingerprint),
						);
						break;
					case "migration.preview":
						result = await previewLegacyMigration(input.root ?? join(homedir(), ".laplace-local"));
						break;
					case "migration.apply":
						result = await manager.addServers(
							await migrateSelectedLegacy(
								input.root ?? join(homedir(), ".laplace-local"),
								input.selected,
							),
							true,
						);
						break;
					case "browser.resumeRecovery":
						await browserApprovals.resumeRecovery();
						result = { resumed: true };
						break;
					case "browser.list":
						result = browserApprovals.list();
						break;
					case "browser.review":
						result = browserApprovals.review(input.requestId, "desktop");
						break;
					case "browser.approve":
						await browserApprovals.approve(input.requestId, "desktop", input.capability);
						result = browserApprovals.review(input.requestId, "desktop");
						break;
					case "browser.cancel":
						await browserApprovals.cancel(input.requestId, "desktop");
						result = browserApprovals.review(input.requestId, "desktop");
						break;
					case "browser.focus":
						await browserApprovals.focus(input.requestId, "desktop", input.profileId);
						result = browserApprovals.review(input.requestId, "desktop");
						break;
					case "catalog.list":
						result = await catalog.list();
						break;
					case "catalog.install":
						result = await portable.install({
							...input,
							idempotencyKey: input.idempotencyKey ?? randomUUID(),
						});
						break;
					case "portable.install":
						result = await portable.install(input);
						break;
					case "portable.manage":
						result = await portable.manage(input);
						break;
					case "portable.status":
						result = await portable.status(input.id);
						break;
					case "portable.fields":
						result = await portable.fields(input.id);
						break;
					case "portable.devices":
						result = await portable.devices();
						break;
					case "portable.copy":
						result = await portable.copy(input.sourceId, input.idempotencyKey);
						break;
					case "server.access":
						result = await manager.setAccess(input.id, input.access);
						break;
					case "catalog.authenticate":
						result = await portable.manage({ action: "authenticate", id: input.id });
						break;
					case "catalog.verify":
						result = await portable.manage({ action: "verify", id: input.id });
						break;
					case "catalog.notificationsDelivered":
						result = await catalog.acknowledgeNotifications(input.owner, input.ids);
						break;
					case "catalog.cancel":
						result = catalog.cancel(input.jobId);
						break;
					case "client.list":
						result = manager.listClients();
						break;
					case "client.register":
						result = await manager.registerClient(input.name);
						break;
					case "client.permissions":
						result = await manager.setClientTools(input.clientId, input.tools);
						break;
					case "client.revoke":
						result = await manager.revokeClient(input.clientId);
						await hosted.disconnect(input.clientId);
						break;
					case "client.preview-install":
					case "client.install": {
						manager.client(input.clientId);
						const registration = {
							...input,
							...bridgeRegistration,
							root,
						};
						result =
							request.method === "client.install"
								? await registerClient(registration)
								: await previewClientRegistration(registration);
						if (request.method === "client.install") {
							const token = (await manager.entries(`client:${input.clientId}`)).getPassword();
							if (!token || !manager.endpoint) throw new Error("Client verification unavailable");
							const check = new Client({ name: "Desktop setup verification", version: "1" });
							const transport = new StreamableHTTPClientTransport(new URL(manager.endpoint), {
								requestInit: { headers: { Authorization: `Bearer ${token}` } },
							});
							try {
								await check.connect(transport);
								const listed = await check.listTools();
								if (!listed.tools.some((t) => t.name === "local_connectors_list"))
									throw new Error("Allow connector setup tools for this AI client");
							} finally {
								await transport.terminateSession().catch(() => {});
								await check.close().catch(() => {});
							}
							await configurePluginBridge(registration);
						}
						break;
					}
					case "hosted.connect":
						result = await hosted.connect(input.clientId, true, input.desktopManagement);
						break;
					case "hosted.disconnect":
						result = await hosted.disconnect(input.clientId);
						break;
					case "link.prepare":
						result = await manager.prepareLink(input.origin);
						break;
					case "link.complete":
						result = await manager.completeLink(input);
						break;
					case "link.unlink":
						result = await manager.unlink();
						break;
					case "link.block":
						result = await manager.blockLink();
						break;
					case "shutdown":
						send({ id: request.id, result: { stopping: true } });
						await stop();
						return;
				}
				send({ id: request.id, result });
				send({ event: "snapshot", data: manager.status() });
			} catch (error) {
				if (request.method.startsWith("credentials.")) {
					const code =
						error instanceof CredentialSetupError
							? error.code
							: error instanceof z.ZodError
								? "invalid"
								: "failed";
					send({ id: request.id, result: { error: { code, message: credentialMessages[code] } } });
					return;
				}
				send({
					id: request.id,
					error: request.method.startsWith("credentials.")
						? "Credential operation failed. Check Bitwarden sign-in, unlock, and configuration. No secret values were returned."
						: error instanceof z.ZodError
							? "Invalid local operation settings"
							: error instanceof Error
								? error.message
								: "Local operation failed",
				});
			} finally {
				if (counted) activeHelperRequests--;
			}
		})();
	});
	if (!process.connected) {
		await stop();
		return { manager, hosted, server, stop };
	}
	send({ event: "snapshot", data: manager.status() });
	send({ event: "ready" });
	void hosted.restore().catch(() => {});
	return { manager, hosted, server, stop };
}
if (process.argv[1]?.endsWith("main.cjs") || process.argv[1]?.endsWith("main.ts"))
	void startHelper().catch(() => {
		process.stderr.write(
			"Laplace Desktop manager initialization failed. Check its keychain, runtime, and profile lock.\n",
		);
		process.exitCode = 1;
		process.disconnect?.();
	});
