import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

import { credentialMessages } from "../shared/credential-setup";
import {
	helperInputs,
	helperRequest,
	type HelperEvent,
	type HelperReply,
} from "../shared/helper-contracts";
import { BrowserApprovals } from "./browser-approvals";
import { CatalogInstaller } from "./catalog";
import {
	previewClientRegistration,
	registerClient,
	configurePluginBridge,
} from "./client-registration";
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
		await browserApprovals.initialize();
		server = await startMcpServer(
			manager,
			hosted,
			credentials,
			new ConnectorManagement(manager, catalog, portable, browserApprovals, (requestId) =>
				send({ event: "browser-approval", requestId }),
			),
		);
	} catch (error) {
		credentials.close();
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
		clearInterval(parentWatch);
		if (snapshotTimer) clearTimeout(snapshotTimer);
		for (const job of catalog.jobs())
			if (job.status === "running")
				try {
					catalog.cancel(job.id);
				} catch {}
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
	process.on("message", (raw: unknown) => {
		void (async () => {
			const parsed = helperRequest.safeParse(raw);
			if (!parsed.success) return;
			const request = parsed.data;
			try {
				const input: any = helperInputs[request.method].parse(request.input);
				if (closing && request.method !== "shutdown")
					throw new Error("Laplace Desktop is stopping");
				let result: unknown;
				switch (request.method) {
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
							nodePath: process.execPath,
							bridgePath: join(dirname(process.argv[1]!), "bridge.cjs"),
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
