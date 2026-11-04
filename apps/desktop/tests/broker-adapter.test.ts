import { randomUUID } from "node:crypto";

import type { BrokerSession, BrokerItem } from "@repo/project-protocol/credential-broker";
import { expect, it, vi } from "vitest";

import { desktopBrokerAdapter } from "../src/helper/broker-adapter";
import type { CatalogInstaller } from "../src/helper/catalog";
import type { CredentialBroker } from "../src/helper/credentials";
import type { DesktopManager } from "../src/helper/manager";
import type { PortableConnectors } from "../src/helper/portable";
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

it("opens hosted OAuth in an automatic browser only at execution and rechecks permissions after launch", async () => {
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
	const ensureOwned = vi.fn(async () => {
		sequence.push("browser");
		return "http://127.0.0.1:9223";
	});
	const credentials = {
		allowed: () => allowed,
		brokerAllowed: () => allowed,
		brokerCandidates: async () => [{ id: credentialId }],
		brokerBrowser: { ensureOwned, endpoint: () => "http://127.0.0.1:9223" },
	} as unknown as CredentialBroker;
	const adapter = desktopBrokerAdapter(
		manager,
		credentials,
		{} as CatalogInstaller,
		{} as PortableConnectors,
		() => {},
	);
	const principal = { id: "local:client", name: "Agent", hosted: false, authorize: () => {} };
	const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "oauth-tab" })));
	vi.stubGlobal("fetch", fetcher);
	try {
		await adapter.validate(principal, session, item);
		expect(ensureOwned).not.toHaveBeenCalled();
		const result = await adapter.execute(principal, session, item, new AbortController().signal);
		expect(sequence).toEqual(["browser", "execute"]);
		expect(result).toMatchObject({ browserTargetId: "oauth-tab", state: "user_action_required" });
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringContaining("/json/new?https%3A%2F%2Faccounts.google.com"),
			expect.objectContaining({ method: "PUT" }),
		);
		post.mockClear();
		fetcher.mockClear();
		ensureOwned.mockImplementation(async () => {
			allowed = false;
			return "http://127.0.0.1:9223";
		});
		await expect(
			adapter.execute(principal, session, item, new AbortController().signal),
		).rejects.toThrow();
		expect(post).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});
