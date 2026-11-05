import { randomUUID } from "node:crypto";

import { desktopBrokerAdapter } from "@repo/local-runtime/broker-adapter";
import type { CatalogInstaller } from "@repo/local-runtime/catalog";
import type { CredentialBroker } from "@repo/local-runtime/credentials";
import type { DesktopManager } from "@repo/local-runtime/manager";
import type { PortableConnectors } from "@repo/local-runtime/portable";
import type { BrokerSession, BrokerItem } from "@repo/project-protocol/credential-broker";
import { expect, it, vi } from "vitest";
it("redeems local values directly, follows real installation IDs, and requires connector verification", async () => {
	vi.stubEnv("ENABLE_CREDENTIAL_BROKERING", "true");
	try {
		const item: BrokerItem = {
			target: {
				id: randomUUID(),
				service: "test",
				label: "Test",
				location: "local",
				catalogId: "test",
				authType: "custom_credential",
			},
			matches: [
				{
					field: "apiKey",
					source: {
						kind: "doppler",
						connectionId: "doppler",
						project: "app",
						config: "dev",
						name: "TOKEN",
					},
				},
			],
			state: "running",
			message: "",
		};
		const session: BrokerSession = {
			id: randomUUID(),
			principalId: "local:client",
			revision: 1,
			createdAt: Date.now(),
			expiresAt: Date.now() + 60000,
			items: [item],
			receipts: {},
		};
		const post = vi.fn(async (_path: string, body: { action: string }) =>
			body.action === "redeem"
				? { values: { apiKey: "synthetic-redemption-canary" } }
				: body.action === "describe"
					? { targets: [item.target] }
					: { valid: true },
		);
		const manager = {
			status: () => ({ mode: "linked" }),
			clientToolAllowed: () => true,
			credentialRelayApi: async () => ({ post }),
		} as unknown as DesktopManager;
		const credentials = {
			allowed: () => true,
			brokerAllowed: () => true,
			snapshot: () => ({ unlocked: false }),
			brokerEpoch: "1",
		} as unknown as CredentialBroker;
		let jobStatus = "running";
		const catalog = {
			list: async () => [{ id: "test", fields: [{ key: "apiKey", required: true, default: "" }] }],
			jobs: () => [{ id: "verify-job", status: jobStatus }],
		} as unknown as CatalogInstaller;
		const install = vi.fn(async (_input: unknown, _check: () => void) => ({
				id: "install-operation",
				connectorId: "pc_actual",
			})),
			manage = vi.fn(async (_input: unknown, _check: () => void) => ({ id: "verify-job" })),
			status = vi.fn(async () => [{ id: "install-operation", status: "needs_authentication" }]);
		const portable = { install, manage, status } as unknown as PortableConnectors;
		const principal = { id: "local:client", name: "Agent", hosted: false, authorize: () => {} };
		const adapter = desktopBrokerAdapter(manager, credentials, catalog, portable, () => {});
		const execution = await adapter.execute(principal, session, item, new AbortController().signal);
		expect(install.mock.calls[0]![0]).toEqual({
			catalogId: "test",
			configuration: { apiKey: "synthetic-redemption-canary" },
			idempotencyKey: session.id + ":" + item.target.id,
		});
		expect(manage.mock.calls[0]![0]).toEqual({ action: "verify", id: "pc_actual" });
		expect(execution).toMatchObject({
			connectorId: "pc_actual",
			operationId: "verify-job",
			state: "user_action_required",
		});
		expect(JSON.stringify(execution)).not.toContain("synthetic-redemption-canary");
		Object.assign(item, execution);
		const command = {
			action: "browser" as const,
			sessionId: session.id,
			itemId: item.target.id,
			operation: "verify" as const,
		};
		expect(
			(await adapter.browser(principal, session, item, command, new AbortController().signal))
				.state,
		).toBe("user_action_required");
		jobStatus = "completed";
		expect(
			(await adapter.browser(principal, session, item, command, new AbortController().signal))
				.state,
		).toBe("connected");
	} finally {
		vi.unstubAllEnvs();
	}
});

it("opens hosted OAuth through the existing Chrome extension only after approval and permission checks", async () => {
	const credentialId = randomUUID();
	const item: BrokerItem = {
		target: {
			id: randomUUID(),
			service: "googlesheets",
			label: "Sheets",
			location: "cloud",
			authType: "oauth2",
		},
		matches: [
			{
				field: "login",
				source: { kind: "bitwarden", credentialId },
				origins: ["https://accounts.google.com"],
			},
		],
		state: "review_required",
		message: "",
	};
	const session: BrokerSession = {
		id: randomUUID(),
		principalId: "local:client",
		revision: 1,
		createdAt: Date.now(),
		expiresAt: Date.now() + 60000,
		items: [item],
		receipts: {},
	};
	const sequence: string[] = [];
	const post = vi.fn(async (_: string, body: { action: string }) => {
		if (body.action === "describe") return { targets: [item.target] };
		if (body.action === "execute") {
			sequence.push("execute");
			return {
				status: "requires_user_action",
				requestId: randomUUID(),
				authorizationUrl: "https://accounts.google.com/oauth",
			};
		}
		return { valid: true };
	});
	const manager = {
		status: () => ({ mode: "linked" }),
		clientToolAllowed: () => true,
		credentialRelayApi: async () => ({ post }),
	} as unknown as DesktopManager;
	let allowed = true;
	const ensureOwned = vi.fn();
	const open = vi.fn(async () => {
		sequence.push("browser");
		return "oauth-tab";
	});
	const credentials = {
		allowed: () => allowed,
		brokerAllowed: () => allowed,
		brokerCandidates: async () => [{ id: credentialId }],
		brokerBrowser: { ensureOwned },
		brokerChrome: { open },
	} as unknown as CredentialBroker;
	const adapter = desktopBrokerAdapter(
		manager,
		credentials,
		{} as CatalogInstaller,
		{} as PortableConnectors,
		() => {},
	);
	const principal = { id: "local:client", name: "Agent", hosted: false, authorize: () => {} };
	await adapter.validate(principal, session, item);
	expect(open).not.toHaveBeenCalled();
	const result = await adapter.execute(principal, session, item, new AbortController().signal);
	expect(sequence).toEqual(["execute", "browser"]);
	expect(ensureOwned).not.toHaveBeenCalled();
	expect(result).toMatchObject({ browserTargetId: "oauth-tab", state: "user_action_required" });
	expect(open).toHaveBeenCalledWith(
		"https://accounts.google.com/oauth",
		["https://accounts.google.com"],
		expect.any(AbortSignal),
	);
	post.mockClear();
	open.mockClear();
	allowed = false;
	await expect(
		adapter.execute(principal, session, item, new AbortController().signal),
	).rejects.toThrow();
	expect(post).not.toHaveBeenCalled();
	expect(open).not.toHaveBeenCalled();
});

it("keeps preparation metadata available while assistant authorization is missing", async () => {
	let permission = false,
		hosted = false;
	const manager = {
		status: () => ({ mode: "linked" }),
		clientToolAllowed: () => permission,
	} as unknown as DesktopManager;
	const credentials = {} as CredentialBroker;
	const prepare = vi.fn(async () => {
		if (!hosted) throw Error("Denied");
	});
	const adapter = desktopBrokerAdapter(
		manager,
		credentials,
		{} as CatalogInstaller,
		{} as PortableConnectors,
		() => {},
		undefined,
		prepare,
	);
	const principal = { id: "local:client", name: "Agent", hosted: false, authorize: () => {} };
	const item: BrokerItem = {
		target: {
			id: randomUUID(),
			service: "sheets",
			label: "Sheets",
			location: "cloud",
			authType: "oauth2",
		},
		matches: [],
		state: "matching",
		message: "",
	};
	const session: BrokerSession = {
		id: randomUUID(),
		principalId: principal.id,
		revision: 0,
		createdAt: Date.now(),
		expiresAt: Date.now() + 60000,
		items: [item],
		receipts: {},
	};
	await adapter.authorize(principal);
	expect(adapter.readiness!(principal, session).code).toBe("authorize_management");
	await expect(adapter.validate(principal, session, item)).rejects.toThrow("connector management");
	await adapter.prepare!(principal, session);
	expect(prepare).not.toHaveBeenCalled();
	permission = true;
	await adapter.prepare!(principal, session);
	expect(adapter.readiness!(principal, session).code).toBe("authorize_management");
	hosted = true;
	await adapter.prepare!(principal, session);
	expect(adapter.readiness!(principal, session).code).toBe("ready");
	expect(prepare).toHaveBeenCalledTimes(2);
});
