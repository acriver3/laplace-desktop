import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EntryFactory } from "@repo/local-mcp-core/store";
import {
	ConnectionBroker,
	type ConnectionBrokerAdapter,
} from "@repo/local-runtime/connection-broker";
import {
	brokerMcpResult,
	brokerTools,
	checkBrokerTool,
	brokerToolInput,
} from "@repo/project-protocol/credential-broker";
import { afterEach, expect, it, vi, type Mock } from "vitest";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0)) await work();
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "laplace-broker-"));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	const keys = new Map<string, string>();
	const entries: EntryFactory = async (key) => ({
		getPassword: () => keys.get(key) ?? null,
		setPassword: (v) => {
			keys.set(key, v);
		},
		deletePassword: () => {
			keys.delete(key);
		},
	});
	let epoch = "1",
		allowed = true;
	const principal = {
		id: "local:" + randomUUID(),
		name: "Assistant",
		hosted: false,
		authorize: () => {
			if (!allowed) throw Error("Revoked");
		},
	};
	const source = {
		kind: "doppler" as const,
		connectionId: "doppler",
		project: "project",
		config: "dev",
		name: "API_KEY",
	};
	const adapter: Omit<ConnectionBrokerAdapter, "execute" | "browser"> & {
		execute: Mock<ConnectionBrokerAdapter["execute"]>;
		browser: Mock<ConnectionBrokerAdapter["browser"]>;
	} = {
		authorize: async (p) => {
			await p.authorize();
		},
		epoch: () => epoch,
		candidates: async () => [{ source, label: "project/dev/API_KEY" }],
		validate: async () => {},
		execute: vi.fn(async () => ({ state: "connected" as const, message: "Verified" })),
		browser: vi.fn(async () => ({ state: "connected" as const })),
		focus: () => {},
	};
	const broker = new ConnectionBroker(root, adapter, () => {}, entries);
	await broker.initialize();
	cleanup.unshift(() => broker.shutdown());
	const sessionId = randomUUID(),
		itemId = randomUUID();
	const target = {
		id: itemId,
		service: "example",
		label: "Example",
		location: "cloud",
		authType: "api_key",
	};
	const call = (command: unknown, id = randomUUID()) =>
		broker.call(principal, { sessionId, ...(command as object) }, id);
	await call({ action: "start", targets: [target] });
	const propose = () => call({ action: "propose", itemId, matches: [{ field: "apiKey", source }] });
	const review = () => call({ action: "review" });
	return {
		broker,
		adapter,
		principal,
		sessionId,
		itemId,
		target,
		source,
		call,
		propose,
		review,
		entries,
		root,
		lock: () => {
			epoch = "2";
			broker.invalidate();
		},
		revoke: () => {
			allowed = false;
		},
	};
}
it("executes only selected items after UI approval and does not repeat duplicate approval", async () => {
	const f = await fixture();
	await f.propose();
	expect(f.adapter.execute).not.toHaveBeenCalled();
	const r = await f.review();
	const id = randomUUID();
	await f.call({ action: "approve", capability: r.capability, itemIds: [f.itemId] }, id);
	await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(1));
	await f.call({ action: "approve", capability: r.capability, itemIds: [f.itemId] }, id);
	expect(f.adapter.execute).toHaveBeenCalledTimes(1);
});
it("rejects capabilities after mapping changes, lock, and ownership changes", async () => {
	const f = await fixture();
	await f.propose();
	const first = await f.review();
	await f.propose();
	await expect(
		f.call({ action: "approve", capability: first.capability, itemIds: [f.itemId] }),
	).rejects.toThrow();
	const second = await f.review();
	f.lock();
	await expect(
		f.call({ action: "approve", capability: second.capability, itemIds: [f.itemId] }),
	).rejects.toThrow();
	await expect(
		f.broker.call(
			{ ...f.principal, id: "another" },
			{ action: "review", sessionId: f.sessionId },
			randomUUID(),
		),
	).rejects.toThrow();
	expect(f.adapter.execute).not.toHaveBeenCalled();
});
it("does not trust a model-provided source label", async () => {
	const f = await fixture();
	await f.call({
		action: "propose",
		itemId: f.itemId,
		matches: [{ field: "apiKey", source: f.source, label: "Misleading account" }],
	});
	expect(JSON.stringify((await f.review()).view)).toContain("project/dev/API_KEY");
	expect(JSON.stringify((await f.review()).view)).not.toContain("Misleading");
});
it("records interrupted execution and never replays it after helper restart", async () => {
	const f = await fixture();
	let finish: () => void = () => {};
	f.adapter.execute = vi.fn(
		() =>
			new Promise<{ state: "connected" }>((resolve) => {
				finish = () => resolve({ state: "connected" });
			}),
	);
	await f.propose();
	const r = await f.review();
	await f.call({ action: "approve", capability: r.capability, itemIds: [f.itemId] });
	// Approval schedules execution after persisting its receipt. Interrupt only once
	// the adapter has actually started, rather than racing that durable write.
	await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(1));
	const restarted = new ConnectionBroker(f.root, f.adapter, () => {}, f.entries);
	try {
		await restarted.initialize();
		const result = await restarted.call(
			f.principal,
			{ action: "status", sessionId: f.sessionId },
			randomUUID(),
		);
		expect(result.view.items[0]!.state).toBe("failed");
		expect(f.adapter.execute).toHaveBeenCalledTimes(1);
	} finally {
		finish();
		// Drain the original simulated process before removing its temporary store.
		await vi.waitFor(async () => {
			const result = await f.call({ action: "status" });
			expect(result.view.items[0]!.state).toBe("connected");
		});
		await restarted.shutdown();
	}
});
it("revokes remaining work without pretending to undo completed connections", async () => {
	const f = await fixture();
	await f.propose();
	f.revoke();
	await expect(f.call({ action: "review" })).rejects.toThrow();
	expect(f.adapter.execute).not.toHaveBeenCalled();
});
it("does not expose approval capabilities in text or structured output", () => {
	const capability = "ui-only-canary";
	const result = brokerMcpResult(
		{ status: "complete", result: { view: { revision: 2 }, capability } },
		{},
		"credential_broker_review",
	);
	expect(JSON.stringify(result.content)).not.toContain(capability);
	expect(JSON.stringify(result.structuredContent)).not.toContain(capability);
	expect(result._meta.brokerCapability).toBe(capability);
});
it("the model tool cannot approve and transport does not accept secret values", () => {
	const input = {
		requestId: randomUUID(),
		command: {
			action: "approve",
			sessionId: randomUUID(),
			capability: "a".repeat(43),
			itemIds: [randomUUID()],
		},
	};
	expect(() => checkBrokerTool("credential_broker", brokerToolInput.parse(input))).toThrow();
	expect(brokerToolInput.safeParse({ ...input, password: "canary" }).success).toBe(false);
});

it("continues a partially successful batch and leaves excluded rows untouched", async () => {
	const f = await fixture(),
		sessionId = randomUUID(),
		second = randomUUID(),
		excluded = randomUUID();
	await f.call({
		sessionId,
		action: "start",
		targets: [f.target, { ...f.target, id: second }, { ...f.target, id: excluded }],
	});
	for (const itemId of [f.itemId, second, excluded])
		await f.call({
			sessionId,
			action: "propose",
			itemId,
			matches: [{ field: "apiKey", source: f.source }],
		});
	f.adapter.execute = vi.fn(async (_p, _s, item) => {
		if (item.target.id === f.itemId) throw Error("synthetic-secret");
		return { state: "connected" as const };
	});
	const review = await f.call({ sessionId, action: "review" });
	await f.call({
		sessionId,
		action: "approve",
		capability: review.capability,
		itemIds: [f.itemId, second],
	});
	await vi.waitFor(async () => {
		const result = await f.call({ sessionId, action: "status" });
		expect(result.view.items.map((i) => i.state)).toEqual([
			"failed",
			"connected",
			"review_required",
		]);
		expect(JSON.stringify(result)).not.toContain("synthetic-secret");
	});
});
it("serializes browser items and resumes waiting approved work after verification", async () => {
	const f = await fixture(),
		sessionId = randomUUID(),
		second = randomUUID();
	await f.call({ sessionId, action: "start", targets: [f.target, { ...f.target, id: second }] });
	for (const itemId of [f.itemId, second])
		await f.call({
			sessionId,
			action: "propose",
			itemId,
			matches: [{ field: "apiKey", source: f.source }],
		});
	f.adapter.execute = vi.fn(async () => ({
		state: "user_action_required" as const,
		browserTargetId: "tab",
	}));
	const review = await f.call({ sessionId, action: "review" });
	await f.call({
		sessionId,
		action: "approve",
		capability: review.capability,
		itemIds: [f.itemId, second],
	});
	await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(1));
	await vi.waitFor(async () =>
		expect((await f.call({ sessionId, action: "status" })).view.items[0]!.state).toBe(
			"user_action_required",
		),
	);
	await f.call({ sessionId, action: "browser", itemId: f.itemId, operation: "verify" });
	await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(2));
	await f.call({ sessionId, action: "cancel" });
});
it("requires fresh approval after locking and does not replay an attempted login", async () => {
	const f = await fixture();
	f.adapter.execute = vi.fn(async () => ({
		state: "user_action_required" as const,
		browserTargetId: "tab",
	}));
	await f.propose();
	const first = await f.review();
	await f.call({ action: "approve", capability: first.capability, itemIds: [f.itemId] });
	await vi.waitFor(async () =>
		expect((await f.call({ action: "status" })).view.items[0]!.state).toBe("user_action_required"),
	);
	f.lock();
	expect((await f.call({ action: "status" })).view.items[0]!.state).toBe("review_required");
	await expect(
		f.call({ action: "browser", itemId: f.itemId, operation: "advance", pageRevision: "old" }),
	).rejects.toThrow();
	const next = await f.review();
	await f.call({ action: "approve", capability: next.capability, itemIds: [f.itemId] });
	await vi.waitFor(async () =>
		expect((await f.call({ action: "status" })).view.items[0]!.state).toBe("user_action_required"),
	);
	expect(f.adapter.execute).toHaveBeenCalledTimes(1);
	await f.call({ action: "cancel" });
});
it("cancellation prevents the next batch item, even if an in-flight operation completes", async () => {
	const f = await fixture(),
		sessionId = randomUUID(),
		second = randomUUID();
	let finish: (v: { state: "connected" }) => void = () => {};
	f.adapter.execute = vi.fn(
		() =>
			new Promise<{ state: "connected" }>((resolve) => {
				finish = resolve;
			}),
	);
	await f.call({ sessionId, action: "start", targets: [f.target, { ...f.target, id: second }] });
	for (const itemId of [f.itemId, second])
		await f.call({
			sessionId,
			action: "propose",
			itemId,
			matches: [{ field: "apiKey", source: f.source }],
		});
	const r = await f.call({ sessionId, action: "review" });
	await f.call({
		sessionId,
		action: "approve",
		capability: r.capability,
		itemIds: [f.itemId, second],
	});
	await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(1));
	await f.call({ sessionId, action: "cancel" });
	finish({ state: "connected" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(f.adapter.execute).toHaveBeenCalledTimes(1);
	expect(
		(await f.call({ sessionId, action: "status" })).view.items.every(
			(i) => i.state === "cancelled",
		),
	).toBe(true);
});

it.each(
	["local_credential_broker", "credential_broker", "local_credential_broker_show"].flatMap(
		(tool) =>
			[
				[tool, false],
				[tool, true],
			] as const,
	),
)(
	"renders and approves the actual MCP card over %s routing (automatic=%s)",
	async (tool, automatic) => {
		const { chromium } = await import("@playwright/test");
		const { existsSync } = await import("node:fs");
		if (!existsSync(chromium.executablePath())) return;
		const { brokerApprovalResource } =
			await import("@repo/project-protocol/mcp/broker-approval-resource");
		const f = await fixture();
		f.adapter.automatic = automatic;
		let unlocked = !automatic;
		f.adapter.readiness = () =>
			unlocked
				? { code: "ready", message: "Ready" }
				: { code: "unlock_vault", message: "Unlock to continue", action: "unlock" };
		f.adapter.unlock = vi.fn(() => {
			unlocked = true;
		});
		await f.propose();
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			const calls: Array<{ name: string; arguments: unknown }> = [];
			const modelContexts: unknown[] = [];
			await page.exposeFunction("brokerHost", async (message: any) => {
				if (message.method === "ui/initialize")
					return {
						hostContext: { theme: "light" },
						protocolVersion: "2026-01-26",
						hostCapabilities: {},
					};
				if (message.method === "tools/call") {
					calls.push(message.params);
					const input = brokerToolInput.parse(message.params.arguments);
					checkBrokerTool(message.params.name, input);
					return brokerMcpResult(
						{
							status: "complete",
							result: await f.broker.call(f.principal, input.command, input.requestId),
						},
						input,
						message.params.name,
					);
				}
				if (message.method === "ui/update-model-context") modelContexts.push(message.params);
				return {};
			});
			await page.route("https://broker-card.invalid/", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: "<html><body><iframe style='width:780px;height:800px;border:0'></iframe></body></html>",
				}),
			);
			await page.goto("https://broker-card.invalid/");
			const initial = brokerMcpResult(
				{ status: "complete", result: await f.call({ action: "status" }) },
				{},
				tool,
			);
			await page.evaluate(
				({ html, initial }) => {
					const frame = document.querySelector("iframe")!;
					window.addEventListener("message", async (event) => {
						if (event.source !== frame.contentWindow) return;
						const msg = event.data;
						if (msg.method === "ui/notifications/initialized") {
							frame.contentWindow!.postMessage(
								{ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: initial },
								"*",
							);
							return;
						}
						if (msg.id) {
							try {
								const result = await (window as any).brokerHost(msg);
								frame.contentWindow!.postMessage({ jsonrpc: "2.0", id: msg.id, result }, "*");
							} catch {
								frame.contentWindow!.postMessage(
									{ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Rejected" } },
									"*",
								);
							}
						}
					});
					frame.srcdoc = html;
				},
				{ html: brokerApprovalResource().text, initial },
			);
			const card = page.frameLocator("iframe");
			if (!automatic)
				expect(
					await card
						.getByRole("button", { name: "Choose or change credential", exact: true })
						.count(),
				).toBe(0);
			if (automatic) {
				await card.getByRole("button", { name: "Unlock Bitwarden", exact: true }).click();
				await vi.waitFor(() => expect(f.adapter.unlock).toHaveBeenCalledWith(f.sessionId));
			}
			await card.getByRole("button", { name: "Approve selected", exact: true }).click();
			await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(1));
			expect(calls.map((c) => c.name)).toEqual(
				expect.arrayContaining([
					tool.replace(/_show$/, "") + "_review",
					tool.replace(/_show$/, "") + "_approve",
				]),
			);
			if (!automatic) await vi.waitFor(() => expect(modelContexts.length).toBe(1));
			const approval = calls.find((c) => c.name.endsWith("_approve"))!.arguments as {
				command: { capability: string };
			};
			expect(JSON.stringify(modelContexts)).not.toContain(approval.command.capability);
			if (!automatic) await card.getByRole("button", { name: "Refresh", exact: true }).click();
			await vi.waitFor(
				async () =>
					expect((await card.locator("article").innerText()).toLowerCase()).toContain("connected"),
				{ timeout: 8000 },
			);
			if (automatic) expect(modelContexts).toHaveLength(0);
			if (tool === "credential_broker")
				await page.screenshot({ path: "/tmp/lap13-broker-card.png" });
		} finally {
			await browser.close();
		}
	},
	30000,
);

it("invalidates review when a credential label or origin changes externally", async () => {
	const f = await fixture();
	await f.propose();
	const r = await f.review();
	f.adapter.candidates = async () => [{ source: f.source, label: "Renamed account" }];
	await expect(
		f.call({ action: "approve", capability: r.capability, itemIds: [f.itemId] }),
	).rejects.toThrow("metadata changed");
	expect(f.adapter.execute).not.toHaveBeenCalled();
	expect((await f.call({ action: "status" })).view.items[0]!.state).toBe("matching");
});
it("binds sessions to installation/account and rejects expired UI capabilities", async () => {
	const f = await fixture();
	await f.propose();
	const r = await f.review();
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61000);
	try {
		await expect(
			f.call({ action: "approve", capability: r.capability, itemIds: [f.itemId] }),
		).rejects.toThrow("expired");
	} finally {
		clock.mockRestore();
	}
	f.adapter.scope = () => ({ accountId: "another", installationId: randomUUID() });
	await expect(f.call({ action: "review" })).rejects.toThrow("unavailable");
	expect(f.broker.list()).toEqual([]);
});

it("never resubmits the same browser page through a different request ID", async () => {
	const f = await fixture();
	f.adapter.execute = vi.fn(async () => ({ state: "user_action_required" as const }));
	f.adapter.browser = vi.fn(async () => ({ state: "user_action_required" as const }));
	await f.propose();
	const r = await f.review();
	await f.call({ action: "approve", capability: r.capability, itemIds: [f.itemId] });
	await vi.waitFor(async () =>
		expect((await f.call({ action: "status" })).view.items[0]!.state).toBe("user_action_required"),
	);
	await f.call({
		action: "browser",
		itemId: f.itemId,
		operation: "advance",
		pageRevision: "page-one",
	});
	await expect(
		f.call({ action: "browser", itemId: f.itemId, operation: "advance", pageRevision: "page-one" }),
	).rejects.toThrow("already submitted");
	expect(f.adapter.browser).toHaveBeenCalledTimes(1);
	await f.call({ action: "cancel" });
});

it("exposes chat review to the model while keeping approval app-only", () => {
	const list = brokerTools(true);
	const show = list.find((t) => t.name === "local_credential_broker_show")!;
	expect(show._meta.ui.visibility).toContain("model");
	expect(show._meta.ui.resourceUri).toBe("ui://laplace/credential-broker.html");
	expect(
		list.find((t) => t.name === "local_credential_broker_approve")!._meta.ui.visibility,
	).toEqual(["app"]);
	const sessionId = randomUUID();
	expect(() =>
		checkBrokerTool(show.name, {
			requestId: randomUUID(),
			command: { action: "review", sessionId },
		}),
	).not.toThrow();
	for (const action of ["approve", "desktop", "cancel", "status"]) {
		expect(() =>
			checkBrokerTool(show.name, {
				requestId: randomUUID(),
				command: { action, sessionId } as any,
			}),
		).toThrow();
	}
});

it("continues approved browser steps without an assistant turn and verifies before connected", async () => {
	const f = await fixture();
	f.adapter.automatic = true;
	f.adapter.execute.mockResolvedValue({ state: "user_action_required", browserTargetId: "tab" });
	let submitted = false;
	f.adapter.browser.mockImplementation(async (_p, _s, _i, command) => {
		if (command.operation === "verify")
			return { state: submitted ? "connected" : "user_action_required" };
		if (command.operation === "inspect")
			return { state: "user_action_required", observation: { handoff: false, revision: "page1" } };
		submitted = true;
		return { state: "user_action_required" };
	});
	await f.propose();
	const review = await f.review();
	await f.call({ action: "approve", itemIds: [f.itemId], capability: review.capability });
	await vi.waitFor(
		async () => expect((await f.call({ action: "status" })).view.items[0]?.state).toBe("connected"),
		{ timeout: 10000 },
	);
	expect(
		f.adapter.browser.mock.calls.filter((call) => call[3].operation === "advance"),
	).toHaveLength(1);
	expect((await f.call({ action: "status" })).view.items[0]?.submittedPages).toEqual(["page1"]);
});

it("never silently advances again after an uncertain submission", async () => {
	const f = await fixture();
	f.adapter.automatic = true;
	f.adapter.execute.mockResolvedValue({ state: "user_action_required", browserTargetId: "tab" });
	let attempts = 0;
	f.adapter.browser.mockImplementation(async (_p, _s, _i, command) => {
		if (command.operation === "advance") {
			attempts++;
			throw Error("uncertain synthetic-secret-canary");
		}
		return {
			state: "user_action_required",
			observation: { handoff: false, revision: "page" + attempts },
		};
	});
	await f.propose();
	const review = await f.review();
	await f.call({ action: "approve", itemIds: [f.itemId], capability: review.capability });
	await vi.waitFor(() => expect(attempts).toBe(1), { timeout: 6000 });
	await new Promise((resolve) => setTimeout(resolve, 3000));
	expect(attempts).toBe(1);
	expect(JSON.stringify(await f.call({ action: "status" }))).not.toContain(
		"synthetic-secret-canary",
	);
	await f.call({ action: "cancel" });
});

it("requires an app-only capability for OAuth navigation without credentials", async () => {
	const f = await fixture();
	const sessionId = randomUUID();
	const call = (command: unknown) =>
		f.broker.call(f.principal, { sessionId, ...(command as object) }, randomUUID());
	await call({ action: "start", targets: [{ ...f.target, authType: "oauth2" }] });
	const review = await call({ action: "review" });
	expect(() =>
		checkBrokerTool("local_credential_broker", {
			requestId: randomUUID(),
			command: {
				action: "connect",
				sessionId,
				capability: review.capability!,
				itemIds: [f.itemId],
			},
		}),
	).toThrow();
	await call({ action: "connect", capability: review.capability, itemIds: [f.itemId] });
	await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(1));
	expect(f.adapter.execute.mock.calls[0]?.[2].matches).toEqual([]);
});

it("opens only a local unlock prompt and retains the same request and mapping", async () => {
	const f = await fixture();
	await f.propose();
	let unlocked = false;
	f.adapter.readiness = () =>
		unlocked
			? { code: "ready", message: "Ready" }
			: { code: "unlock_vault", message: "Unlock locally", action: "unlock" };
	f.adapter.unlock = vi.fn();
	const before = await f.call({ action: "status" });
	await f.call({ action: "unlock" });
	expect(f.adapter.unlock).toHaveBeenCalledWith(f.sessionId);
	expect(f.adapter.execute).not.toHaveBeenCalled();
	unlocked = true;
	const after = await f.call({ action: "status" });
	expect(after.view.id).toBe(before.view.id);
	expect(after.view.items[0]?.matches).toEqual(before.view.items[0]?.matches);
	expect(after.view.readiness?.code).toBe("ready");
});

it("retains an untouched draft through account linking without allowing account switching", async () => {
	const f = await fixture();
	f.adapter.scope = () => ({
		accountId: "account-a",
		installationId: "00000000-0000-4000-8000-000000000001",
	});
	const resumed = await f.call({ action: "status" });
	expect(resumed.view).toMatchObject({
		id: f.sessionId,
		accountId: "account-a",
		installationId: "00000000-0000-4000-8000-000000000001",
		revision: 1,
	});
	f.adapter.scope = () => ({
		accountId: "account-b",
		installationId: "00000000-0000-4000-8000-000000000001",
	});
	await expect(f.call({ action: "status" })).rejects.toThrow("unavailable");
});
it("does not bind a draft with proposed credentials to a newly linked account", async () => {
	const f = await fixture();
	await f.propose();
	f.adapter.scope = () => ({
		accountId: "account-a",
		installationId: "00000000-0000-4000-8000-000000000001",
	});
	await expect(f.call({ action: "status" })).rejects.toThrow("unavailable");
});
