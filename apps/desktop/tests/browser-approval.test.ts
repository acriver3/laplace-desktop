import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserSignInUrl } from "@repo/browser-runtime/browser-approval";
import {
	refreshedApprovalCapability,
	approvalError,
} from "@repo/project-protocol/mcp/browser-approval-card";
import { afterEach, expect, it, vi } from "vitest";

import { BrowserApprovals, browserAuthorizer } from "../src/helper/browser-approvals";
import type { DesktopManager } from "../src/helper/manager";
import { SlackBrowserRelay } from "../src/helper/slack-browser-relay";
import { browserExtensionId } from "../src/shared/browser-extension-id";
import { listBrowserRequests } from "../src/shared/browser-requests";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const fn of cleanup.splice(0).reverse()) await fn();
	delete process.env.LAPLACE_DESKTOP_TEST_ROOT;
});
const identity = { workspace: "https://fixture.slack.com", teamId: "T123456", userId: "U123456" };

it("keeps text review separate from explicit, scoped, single-use confirmation", async () => {
	const f = await fixture();
	await f.report();
	await f.tick();
	const review = f.broker.reviewChat(f.requestId, f.clientId);
	expect(review).toMatchObject({ account: identity, profile: "Chrome · fixture" });
	expect(review.instructions).toContain("Stop and wait");
	expect(JSON.stringify(review)).not.toContain("capabilities");
	expect(f.relay.status().connected).toBe(false);
	await expect(
		f.broker.confirmChat(f.requestId, randomUUID(), review.reviewId!, true),
	).rejects.toThrow("unavailable");
	await expect(
		f.broker.confirmChat(f.requestId, f.clientId, review.reviewId!, false),
	).rejects.toThrow("Explicit approval");
	await f.broker.confirmChat(f.requestId, f.clientId, review.reviewId!, true);
	expect((await f.pair()).token).toBeTruthy();
	await expect(
		f.broker.confirmChat(f.requestId, f.clientId, review.reviewId!, true),
	).rejects.toThrow("Explicit approval");
});

it.each(["account", "profile", "scopes", "expiry", "new-review"])(
	"rejects text approval after %s changes",
	async (change) => {
		const f = await fixture();
		await f.report();
		await f.tick();
		const review = f.broker.reviewChat(f.requestId, f.clientId);
		if (change === "account" || change === "profile") {
			await f.report([
				{
					...f.candidate,
					revision: randomUUID(),
					...(change === "account"
						? { identity: { ...identity, userId: "U999999" } }
						: { profileLabel: "Another Chrome profile" }),
				},
			]);
			await f.tick();
		} else if (change === "scopes")
			Object.assign(f.broker.view(f.requestId, f.clientId), { scopes: ["Expanded access"] });
		else if (change === "expiry") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
		else f.broker.reviewChat(f.requestId, f.clientId);
		await expect(
			f.broker.confirmChat(f.requestId, f.clientId, review.reviewId!, true),
		).rejects.toThrow();
		expect(f.relay.status().connected).toBe(false);
	},
);

it("provides fixed provider sign-in links and never grants access on sign-in alone", async () => {
	expect(browserSignInUrl("outlook", "https://untrusted.example")).toBe(
		"https://outlook.cloud.microsoft/mail/",
	);
	expect(browserSignInUrl("slack-tethered", identity.workspace)).toBe(identity.workspace);
	expect(() => browserSignInUrl("slack-tethered", "https://evil.example/")).toThrow();
	const f = await fixture();
	await f.report([], "sign_in_required");
	await f.tick();
	const review = f.broker.reviewChat(f.requestId, f.clientId);
	expect(review.view.signInUrl).toBe(identity.workspace);
	expect(review.reviewId).toBeUndefined();
	expect(f.relay.status().connected).toBe(false);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "browser-approval-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	process.env.LAPLACE_DESKTOP_TEST_ROOT = root;
	const relay = new SlackBrowserRelay(identity.workspace);
	await relay.listen();
	cleanup.push(() => relay.close());
	const keys = new Map<string, string>();
	let permitted = true;
	const manager = {
		root,
		entries: async (key: string) => ({
			getPassword: () => keys.get(key),
			setPassword: (value: string) => keys.set(key, value),
		}),
		getServerConfig: () => ({ enabled: true }),
		browserSetupConfig: () => ({ enabled: true }),
		client: () => {
			if (!permitted) throw Error("revoked");
		},
		clientToolAllowed: () => permitted,
		changed: vi.fn(),
		catalogSetupCall: vi.fn(async (_id: string, tool: string, args: unknown) => {
			const action = tool.replace("laplace_browser_", "");
			const result =
				action === "pair"
					? relay.pairing()
					: action === "status"
						? relay.status()
						: action === "review"
							? relay.review()
							: action === "authorize"
								? relay.authorize(args)
								: action === "revoke"
									? relay.revoke()
									: action === "focus"
										? relay.focus(args)
										: {};
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		}),
	} as unknown as DesktopManager;
	const broker = new BrowserApprovals(manager);
	cleanup.push(() => broker.close());
	const clientId = randomUUID(),
		requestId = randomUUID(),
		profileId = randomUUID();
	const owner = browserAuthorizer(() => {}, clientId, "local_connectors_authenticate");
	await broker.begin(requestId, "slack", "slack", identity.workspace + "/", owner);
	let ticket = (await listBrowserRequests(join(root, "browser-requests")))[0]!;
	let url = new URL(ticket.pairingUrl),
		code = url.hash.slice(1);
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
	let candidate = {
		id: randomUUID(),
		revision: randomUUID(),
		profileId,
		profileLabel: "Chrome · fixture",
		identity,
	};
	const report = async (list = [candidate], hint = "discovering") => {
		expect(
			(
				await post("/review", {
					code,
					profileId,
					profileLabel: "Chrome · fixture",
					candidates: list,
					hint,
				})
			).status,
		).toBe(200);
	};
	const tick = () => (broker as unknown as { tick: () => Promise<void> }).tick();
	const pair = async () => {
		const decision = await (await post("/decision", { code, profileId })).json();
		return await (
			await post("/pair", {
				code,
				candidateId: candidate.id,
				authorization: decision.authorization,
				identity: candidate.identity,
			})
		).json();
	};
	const renew = async () => {
		ticket = (await listBrowserRequests(join(root, "browser-requests")))[0]!;
		url = new URL(ticket.pairingUrl);
		code = url.hash.slice(1);
		candidate = { ...candidate, id: randomUUID(), revision: randomUUID() };
	};
	return {
		root,
		manager,
		broker,
		relay,
		requestId,
		clientId,
		profileId,
		report,
		tick,
		pair,
		renew,
		post,
		candidate,
		get code() {
			return code;
		},
		revoke: () => {
			permitted = false;
		},
	};
}
it("requires a user capability, binds it to the client and account, and verifies before Connected", async () => {
	const f = await fixture();
	await f.report();
	await f.tick();
	expect((await f.post("/pair", { code: f.code, identity })).status).toBe(400);
	expect(f.broker.view(f.requestId, f.clientId).state).toBe("approval_required");
	expect(() => f.broker.review(f.requestId, randomUUID())).toThrow("unavailable");
	const review = f.broker.review(f.requestId, f.clientId),
		capability = review.capabilities[f.candidate.id]!;
	expect(JSON.stringify(review.view)).not.toContain(capability);
	await expect(f.broker.approve(f.requestId, randomUUID(), capability)).rejects.toThrow();
	await f.broker.approve(f.requestId, f.clientId, capability);
	expect(f.broker.view(f.requestId, f.clientId).state).toBe("verifying");
	await expect(f.broker.approve(f.requestId, f.clientId, capability)).rejects.toThrow();
	const { token } = await f.pair();
	expect(token).toBeTruthy();
	await f.tick();
	expect(f.broker.view(f.requestId, f.clientId).state).toBe("connected");
	expect(f.manager.catalogSetupCall).toHaveBeenCalledWith(
		"slack",
		"channels_list",
		{},
		expect.any(AbortSignal),
	);
	expect(
		(await readFile(join(f.root, "browser-consent.enc"))).includes(Buffer.from(identity.userId)),
	).toBe(false);
});
it("rejects a changed identity, stale candidate revision, expired capability and another request", async () => {
	const f = await fixture();
	await f.report();
	await f.tick();
	let cap = f.broker.review(f.requestId, f.clientId).capabilities[f.candidate.id]!;
	await f.report([
		{ ...f.candidate, revision: randomUUID(), identity: { ...identity, userId: "UOTHER" } },
	]);
	await expect(f.broker.approve(f.requestId, f.clientId, cap)).rejects.toThrow("changed");
	await f.report();
	await f.tick();
	cap = f.broker.review(f.requestId, f.clientId).capabilities[f.candidate.id]!;
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
	await expect(f.broker.approve(f.requestId, f.clientId, cap)).rejects.toThrow("expired");
	clock.mockRestore();
	await expect(f.broker.approve(randomUUID(), f.clientId, cap)).rejects.toThrow();
});
it("keeps an actively reviewed Desktop capability usable beyond its initial minute", async () => {
	const f = await fixture();
	await f.report();
	await f.tick();
	const shown = f.broker.review(f.requestId, "desktop");
	const initial = shown.capabilities[f.candidate.id]!;
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now + 59000);
	expect(f.broker.review(f.requestId, "desktop").capabilities[f.candidate.id]).toBe(initial);
	clock.mockReturnValue(now + 61000);
	await f.report();
	await f.broker.approve(f.requestId, "desktop", initial);
	expect(f.broker.view(f.requestId, "desktop").state).toBe("verifying");
});
it("refreshes an idle review on click without accepting changed account, profile or scopes", async () => {
	const f = await fixture();
	await f.report();
	await f.tick();
	const shown = f.broker.review(f.requestId, "desktop");
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
	await f.report();
	const fresh = f.broker.review(f.requestId, "desktop");
	const cap = refreshedApprovalCapability(
		shown.view,
		f.candidate.id,
		fresh.view,
		fresh.capabilities,
	);
	expect(cap).not.toBe(shown.capabilities[f.candidate.id]);
	for (const changed of [
		{ ...fresh.view, scopes: [...fresh.view.scopes, "More access"] },
		{ ...fresh.view, candidates: [{ ...f.candidate, profileId: randomUUID() }] },
		{ ...fresh.view, candidates: [{ ...f.candidate, revision: randomUUID() }] },
		{ ...fresh.view, candidates: [{ ...f.candidate, identity: { ...identity, userId: "other" } }] },
	])
		expect(() =>
			refreshedApprovalCapability(shown.view, f.candidate.id, changed, fresh.capabilities),
		).toThrow("changed");
	await f.broker.approve(f.requestId, "desktop", cap!);
	await expect(f.broker.approve(f.requestId, "desktop", cap!)).rejects.toThrow("expired");
	expect(
		approvalError(
			new Error("Error invoking remote method 'laplace:request': Error: Review expired."),
		),
	).toBe("Review expired.");
});
it("renews temporary transport for the exact saved identity and profile; disconnect revokes consent", async () => {
	const f = await fixture();
	await f.report();
	await f.tick();
	await f.broker.approve(
		f.requestId,
		f.clientId,
		f.broker.review(f.requestId, f.clientId).capabilities[f.candidate.id]!,
	);
	let { token } = await f.pair();
	await f.tick();
	await f.post("/pause", {}, token);
	await f.tick();
	await f.renew();
	await f.report();
	await f.tick();
	({ token } = await f.pair());
	expect(token).toBeTruthy();
	await f.tick();
	const revoked = f.post("/revoke-consent", {}, token);
	await vi.waitFor(() => expect(f.relay.status().revoked).toBe(true));
	await f.tick();
	expect((await revoked).status).toBe(200);
	expect(f.broker.view(f.requestId, f.clientId).state).toBe("cancelled");
	await f.broker.close();
	const restored = new BrowserApprovals(f.manager);
	cleanup.push(() => restored.close());
	await restored.initialize();
	expect(restored.list()).toEqual([]);
});
it("restores remembered approval across Desktop restart without persisting transport secrets", async () => {
	const f = await fixture();
	await f.report();
	await f.tick();
	await f.broker.approve(
		f.requestId,
		f.clientId,
		f.broker.review(f.requestId, f.clientId).capabilities[f.candidate.id]!,
	);
	await f.pair();
	await f.tick();
	await f.broker.close();
	const restored = new BrowserApprovals(f.manager);
	cleanup.push(() => restored.close());
	await restored.initialize();
	expect(restored.list()).toHaveLength(1);
	await f.renew();
	await f.report();
	await (restored as any).tick();
	expect((await f.pair()).token).toBeTruthy();
});
it("surfaces sign-in and permission states, requires selection for multiple accounts, and revokes on client disable", async () => {
	const f = await fixture();
	await f.report([], "sign_in_required");
	await f.tick();
	expect(f.broker.view(f.requestId, f.clientId)).toMatchObject({
		state: "sign_in_required",
		profiles: [{ profileId: f.profileId }],
	});
	await f.report([], "permission_required");
	await f.tick();
	expect(f.broker.view(f.requestId, f.clientId).state).toBe("permission_required");
	await f.report([
		f.candidate,
		{ ...f.candidate, id: randomUUID(), identity: { ...identity, userId: "UOTHER" } },
	]);
	await f.tick();
	expect(f.broker.view(f.requestId, f.clientId).selectedId).toBeUndefined();
	f.revoke();
	await f.tick();
	expect(f.broker.list()).toEqual([]);
});

it("opens a browser only on an explicit one-shot request and discards stale focus on renewal", async () => {
	const f = await fixture();
	await f.report([], "sign_in_required");
	await f.tick();
	const decision = async () =>
		(
			await f.post("/decision", {
				code: f.code,
				profileId: f.profileId,
			})
		).json();
	expect((await decision()).focus).toBe(false);
	await f.broker.focus(f.requestId, f.clientId, f.profileId);
	expect((await decision()).focus).toBe(true);
	expect((await decision()).focus).toBe(false);
	await f.broker.focus(f.requestId, f.clientId, f.profileId);
	const renewed = new URL(f.relay.pairing().pairingUrl);
	expect(
		(
			await (
				await f.post("/decision", {
					code: renewed.hash.slice(1),
					profileId: f.profileId,
				})
			).json()
		).focus,
	).toBe(false);
});

it("clears persisted consent before migration even when no request exists in this process", async () => {
	const f = await fixture();
	await f.report();
	await f.tick();
	await f.broker.approve(
		f.requestId,
		f.clientId,
		f.broker.review(f.requestId, f.clientId).capabilities[f.candidate.id]!,
	);
	await f.pair();
	await f.tick();
	await f.broker.close();
	const restored = new BrowserApprovals(f.manager);
	cleanup.push(() => restored.close());
	await restored.cancelByServer("slack", f.clientId);
	await restored.initialize();
	expect(restored.list()).toHaveLength(0);
	const requestId = randomUUID();
	await restored.begin(
		requestId,
		"slack",
		"slack",
		identity.workspace,
		browserAuthorizer(() => {}, f.clientId, "local_connectors_authenticate"),
	);
	await f.renew();
	await f.report();
	await (restored as any).tick();
	expect(restored.view(requestId, f.clientId).state).toBe("approval_required");
});
