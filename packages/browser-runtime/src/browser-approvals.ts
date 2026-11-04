import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";

import { z } from "zod";

import {
	identityKey,
	browserCandidate,
	browserProviders,
	type BrowserApprovalView,
	type BrowserCandidate,
	type BrowserProviderId,
} from "./browser-approval";
import { publishBrowserRequest } from "./browser-requests";
import { slackWorkspace } from "./slack-browser";

type Owner = { clientId: string; tool: string };
const owners = new WeakMap<() => void, Owner>();
export function browserAuthorizer(fn: () => void, clientId: string, tool: string) {
	owners.set(fn, { clientId, tool });
	return fn;
}
const grant = z.object({
	serverId: z.string(),
	provider: z.enum(["slack", "ycombinator"]),
	workspace: z.string(),
	clientId: z.string(),
	tool: z.string(),
	scopeRevision: z.string(),
	candidate: browserCandidate,
});
export type Grant = z.infer<typeof grant>;
export interface BrowserConsentStore {
	read(): Promise<{ grants: Grant[] }>;
	mutate(work: (state: { grants: Grant[] }) => void | Promise<void>): Promise<unknown>;
}
export interface BrowserApprovalHost {
	root: string;
	getServerConfig(id: string): { enabled: boolean };
	client(id: string): unknown;
	clientToolAllowed(clientId: string, tool: string): boolean;
	changed(): void;
	catalogSetupCall(
		id: string,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export const browserConsentSchema = z.object({ grants: z.array(grant) });
type Request = Owner & {
	id: string;
	serverId: string;
	provider: BrowserProviderId;
	workspace: string;
	expiresAt: number;
	remove?: () => Promise<void>;
	view: BrowserApprovalView;
	consent?: Grant;
	pairing: boolean;
	terminal: boolean;
	verified: boolean;
};
/** Desktop is the sole owner of consent. Native discovery never authorizes a relay. */
export class BrowserApprovals {
	private requests = new Map<string, Request>();
	private capabilities = new Map<
		string,
		{ requestId: string; clientId: string; candidate: BrowserCandidate; expires: number }
	>();
	private timer?: ReturnType<typeof setInterval>;
	private ticking = false;
	private closed = false;
	readonly events: Array<{ at: string; state: string }> = [];
	constructor(
		private manager: BrowserApprovalHost,
		private store: BrowserConsentStore,
	) {}

	private allowed(owner: Owner, serverId: string) {
		const config = this.manager.getServerConfig(serverId);
		if (!config.enabled) throw Error("Connection disabled.");
		if (owner.clientId !== "desktop") {
			this.manager.client(owner.clientId);
			if (!this.manager.clientToolAllowed(owner.clientId, owner.tool))
				throw Error("Setup permission revoked.");
		}
	}
	private async call(serverId: string, action: string, args: Record<string, unknown> = {}) {
		const result = (await this.manager.catalogSetupCall(
			serverId,
			"laplace_browser_" + action,
			args,
			AbortSignal.timeout(8000),
		)) as { isError?: boolean; content: Array<{ text: string }> };
		if (result.isError) throw Error("Browser connection unavailable.");
		return JSON.parse(result.content[0]!.text);
	}
	private update(r: Request, state: BrowserApprovalView["state"], message: string) {
		if (r.terminal && state !== "cancelled" && state !== "expired") return;
		if (r.view.state !== state) {
			this.events.push({ at: new Date().toISOString(), state });
			if (this.events.length > 50) this.events.shift();
		}
		r.view = { ...r.view, state, message };
		this.manager.changed();
	}
	async initialize() {
		for (const saved of (await this.store.read()).grants) {
			try {
				try {
					this.allowed(saved, saved.serverId);
				} catch {
					await this.store.mutate((state) => {
						state.grants = state.grants.filter((g) => g.serverId !== saved.serverId);
					});
					continue;
				}
				if (saved.scopeRevision !== browserProviders[saved.provider].revision) continue;
				await this.begin(
					crypto.randomUUID(),
					saved.serverId,
					saved.provider,
					saved.workspace,
					undefined,
					saved,
				);
			} catch {
				/* A removed/disabled client or connection cannot reconnect. */
			}
		}
		this.timer = setInterval(() => void this.tick(), 1000);
		this.timer.unref();
	}
	async begin(
		id: string,
		serverId: string,
		provider: BrowserProviderId,
		workspace: string,
		authorize?: () => void,
		saved?: Grant,
	) {
		if (this.closed) throw Error("Desktop is stopping.");
		workspace = provider === "slack" ? slackWorkspace(workspace) : workspace;
		const owner = saved ??
			(authorize && owners.get(authorize)) ?? {
				clientId: "desktop",
				tool: "local_connectors_authenticate",
			};
		this.allowed(owner, serverId);
		for (const old of this.requests.values())
			if (old.serverId === serverId && !old.terminal)
				await this.cancel(old.id, old.clientId, false);
		const existing =
			saved ??
			(await this.store.read()).grants.find(
				(g) =>
					g.serverId === serverId &&
					g.clientId === owner.clientId &&
					g.provider === provider &&
					g.workspace === workspace &&
					g.scopeRevision === browserProviders[provider].revision,
			);
		const r: Request = {
			...owner,
			id,
			serverId,
			provider,
			workspace,
			expiresAt: Date.now() + 600000,
			pairing: false,
			terminal: false,
			verified: false,
			consent: existing,
			view: {
				requestId: id,
				provider: browserProviders[provider].label,
				workspace,
				scopes: browserProviders[provider].scopes,
				state: "discovering",
				candidates: [],
				message: "Finding your signed-in account…",
			},
		};
		this.requests.set(id, r);
		await this.pair(r);
		return this.view(id, owner.clientId);
	}
	private async pair(r: Request) {
		this.allowed(r, r.serverId);
		const pairing = await this.call(r.serverId, "pair");
		if (this.closed || r.terminal) throw Error("Request ended.");
		if (pairing.workspace !== r.workspace) throw Error("Workspace changed. Approve again.");
		await r.remove?.();
		r.remove = await publishBrowserRequest(
			{
				id: r.id,
				provider: r.provider,
				environment: basename(this.manager.root),
				workspace: r.workspace,
				...pairing,
			},
			process.env.LAPLACE_DESKTOP_TEST_ROOT
				? join(process.env.LAPLACE_DESKTOP_TEST_ROOT, "browser-requests")
				: undefined,
		);
		r.expiresAt = Date.parse(pairing.expiresAt);
		r.pairing = true;
		r.verified = false;
		this.update(r, "discovering", "Finding your signed-in account…");
	}
	private get(id: string, clientId: string) {
		const r = this.requests.get(id);
		if (!r || (clientId !== "desktop" && r.clientId !== clientId))
			throw Error("Approval request unavailable.");
		if (!r.terminal) this.allowed(r, r.serverId);
		return r;
	}
	view(id: string, clientId: string) {
		return this.get(id, clientId).view;
	}
	list() {
		return [...this.requests.values()].filter((r) => !r.terminal).map((r) => r.view);
	}
	/** Only UI metadata receives these secrets; model-visible status never does. */
	review(id: string, clientId: string) {
		const r = this.get(id, clientId);
		for (const [key, value] of this.capabilities)
			if (value.expires < Date.now()) this.capabilities.delete(key);
		const capabilities: Record<string, string> = {};
		if (r.view.state === "approval_required")
			for (const candidate of r.view.candidates) {
				const prior = [...this.capabilities.entries()].find(
					([, value]) =>
						value.requestId === id &&
						value.clientId === clientId &&
						value.candidate.id === candidate.id &&
						value.candidate.revision === candidate.revision,
				);
				const key = prior?.[0] ?? randomBytes(32).toString("base64url");
				this.capabilities.set(key, {
					requestId: id,
					clientId,
					candidate,
					expires: Math.min(r.expiresAt, Date.now() + 60000),
				});
				capabilities[candidate.id] = key;
			}
		return { view: r.view, capabilities };
	}
	async approve(id: string, clientId: string, capability: string) {
		const r = this.get(id, clientId),
			cap = this.capabilities.get(capability);
		this.capabilities.delete(capability);
		if (
			!cap ||
			cap.requestId !== id ||
			cap.clientId !== clientId ||
			cap.expires < Date.now() ||
			Date.now() >= r.expiresAt ||
			r.terminal ||
			r.view.state !== "approval_required"
		)
			throw Error("Review expired. Refresh the account before approving.");
		const fresh = await this.call(r.serverId, "review");
		if (
			!fresh.candidates.some(
				(c: BrowserCandidate) => JSON.stringify(c) === JSON.stringify(cap.candidate),
			)
		)
			throw Error("The account changed. Review again.");
		this.allowed(r, r.serverId);
		const consent: Grant = {
			serverId: r.serverId,
			provider: r.provider,
			workspace: r.workspace,
			clientId: r.clientId,
			tool: r.tool,
			scopeRevision: browserProviders[r.provider].revision,
			candidate: cap.candidate,
		};
		await this.store.mutate((s) => {
			if (r.terminal || this.closed) throw Error("Request ended.");
			this.allowed(r, r.serverId);
			s.grants = s.grants.filter((g) => g.serverId !== r.serverId);
			s.grants.push(consent);
		});
		r.consent = consent;
		await this.authorize(r, cap.candidate);
		return r.view;
	}
	private async authorize(r: Request, c: BrowserCandidate) {
		if (r.terminal || this.closed) throw Error("Request ended.");
		this.allowed(r, r.serverId);
		await this.call(r.serverId, "authorize", { candidateId: c.id, revision: c.revision });
		this.update(r, "verifying", "Approved. Verifying the connection…");
	}
	async focus(id: string, clientId: string, profileId: string) {
		const r = this.get(id, clientId);
		if (r.terminal) throw Error("Request ended.");
		await this.call(r.serverId, "focus", { profileId });
		return r.view;
	}
	async cancel(id: string, clientId: string, revoke = true) {
		const r = this.requests.get(id);
		if (!r || (clientId !== "desktop" && clientId !== r.clientId))
			throw Error("Approval unavailable.");
		r.terminal = true;
		await r.remove?.();
		if (revoke)
			await this.store.mutate((s) => {
				s.grants = s.grants.filter((g) => g.serverId !== r.serverId);
			});
		await this.call(r.serverId, "revoke").catch(() => {});
		this.update(r, "cancelled", "Connection approval cancelled.");
		return r.view;
	}
	private async tick() {
		if (this.ticking || this.closed) return;
		this.ticking = true;
		try {
			await Promise.all(
				[...this.requests.values()]
					.filter((r) => !r.terminal)
					.map(async (r) => {
						try {
							try {
								this.allowed(r, r.serverId);
							} catch {
								await this.cancel(r.id, "desktop");
								return;
							}
							const status = await this.call(r.serverId, "status");
							if (status.revoked) {
								await this.cancel(r.id, "desktop");
								return;
							}
							if (status.connected) {
								r.pairing = false;
								if (!r.verified) {
									const result = (await this.manager.catalogSetupCall(
										r.serverId,
										browserProviders[r.provider].verify,
										{},
										AbortSignal.timeout(15000),
									)) as { isError?: boolean };
									if (result.isError) throw Error("Verification failed.");
									this.allowed(r, r.serverId);
									r.verified = true;
									await r.remove?.();
									r.remove = undefined;
									this.update(
										r,
										"connected",
										"Connected. Closing the tab pauses access; reopen it to reconnect this account.",
									);
								}
								return;
							}
							if (!r.pairing || Date.now() >= r.expiresAt) {
								if (!r.consent) {
									r.terminal = true;
									await r.remove?.();
									this.update(r, "expired", "Approval expired. Ask to connect again.");
									return;
								}
								await this.pair(r);
							}
							const review = await this.call(r.serverId, "review");
							const candidates = z.array(browserCandidate).max(64).parse(review.candidates);
							r.view = {
								...r.view,
								candidates,
								profiles: review.profiles,
								selectedId: candidates.length === 1 ? candidates[0]!.id : undefined,
							};
							const approved =
								r.consent &&
								candidates.find(
									(c) =>
										c.profileId === r.consent!.candidate.profileId &&
										identityKey(c.identity) === identityKey(r.consent!.candidate.identity),
								);
							if (approved) {
								await this.authorize(r, approved);
								return;
							}
							this.update(
								r,
								candidates.length
									? "approval_required"
									: review.hint === "permission_required"
										? "permission_required"
										: review.hint === "sign_in_required"
											? "sign_in_required"
											: "discovering",
								candidates.length
									? "Approve access to this account. Approval is remembered until you disconnect."
									: review.hint === "permission_required"
										? "Allow the updated extension’s site permissions in Chrome."
										: review.hint === "sign_in_required"
											? "Open your service tab, or choose Finish signing in. Closed tabs stay closed."
											: "Looking for the browser extension. Check that it is installed and Chrome is running.",
							);
						} catch {
							if (!r.terminal)
								this.update(
									r,
									"disconnected",
									"Browser connection unavailable. Waiting to reconnect; no actions will be replayed.",
								);
						}
					}),
			);
		} finally {
			this.ticking = false;
		}
	}
	async close() {
		this.closed = true;
		clearInterval(this.timer);
		while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 10));
		await Promise.all(
			[...this.requests.values()].map(async (r) => {
				await r.remove?.();
			}),
		);
	}
}
