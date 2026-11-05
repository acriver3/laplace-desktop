import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";

import { z } from "zod";

import {
	identityKey,
	browserCandidate,
	browserProviders,
	browserSignInUrl,
	type BrowserApprovalView,
	type BrowserCandidate,
	type BrowserProviderId,
} from "./browser-approval";
import { publishBrowserRequest } from "./browser-requests";
import {
	sessionRecoveryEnabled,
	classifyRecovery,
	recoveryDelay,
	recoveryMessage,
} from "./session-recovery";
import { slackWorkspace } from "./slack-browser";

type Owner = { clientId: string; tool: string };
const owners = new WeakMap<() => void, Owner>();
export function browserAuthorizer(fn: () => void, clientId: string, tool: string) {
	owners.set(fn, { clientId, tool });
	return fn;
}
const grant = z.object({
	serverId: z.string(),
	provider: z.enum(["slack", "ycombinator", "outlook", "slack-tethered"]),
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
	recoveryAttempts?: number;
	nextRetryAt?: number;
	recoveryStartedAt?: number;
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
/** The initiating Laplace client owns consent. Native discovery never authorizes a relay. */
export class BrowserApprovals {
	private requests = new Map<string, Request>();
	private capabilities = new Map<
		string,
		{ requestId: string; clientId: string; candidate: BrowserCandidate; expires: number }
	>();
	private chatReviews = new Map<
		string,
		{
			requestId: string;
			clientId: string;
			candidate: BrowserCandidate;
			scopeRevision: string;
			scopes: string;
			expires: number;
		}
	>();
	private timer?: ReturnType<typeof setInterval>;
	private ticking = false;
	private closed = false;
	readonly events: Array<{ at: string; state: string }> = [];
	readonly recoveryEvents: Array<{ reason: string; attempts: number; elapsedMs: number }> = [];
	private recordRecovery(r: Request, reason: string) {
		this.recoveryEvents.push({
			reason,
			attempts: r.recoveryAttempts ?? 0,
			elapsedMs: r.recoveryStartedAt ? Date.now() - r.recoveryStartedAt : 0,
		});
		if (this.recoveryEvents.length > 50) this.recoveryEvents.shift();
	}
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
		if (sessionRecoveryEnabled()) {
			r.view.recovery =
				state === "sign_in_required"
					? { state, reason: "session_expired" }
					: state === "permission_required" || state === "approval_required"
						? { state: "approval_required", reason: state }
						: state === "discovering"
							? { state: "browser_required", reason: "browser_required" }
							: state === "connected" || state === "cancelled"
								? undefined
								: r.view.recovery;
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
		if (this.closed) throw Error("Laplace is stopping.");
		workspace =
			provider === "slack" || provider === "slack-tethered" ? slackWorkspace(workspace) : workspace;
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
				signInUrl: browserSignInUrl(provider, workspace),
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
				...(sessionRecoveryEnabled() ? { sessionRecoveryV1: true } : {}),
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
	/** A model-visible review is distinct from the UI-only capability. The host agent
	 * must present these details and obtain the user's explicit reply before confirmChat. */
	reviewChat(id: string, clientId: string, candidateId?: string) {
		const r = this.get(id, clientId);
		for (const [key, value] of this.chatReviews)
			if (value.expires <= Date.now() || (value.requestId === id && value.clientId === clientId))
				this.chatReviews.delete(key);
		if (r.view.state !== "approval_required")
			return {
				view: r.view,
				instructions:
					r.view.state === "sign_in_required"
						? "Give the user signInUrl to sign in in their existing Chrome profile, then check this request again. Do not approve automatically."
						: "Wait for account discovery or resolve the displayed status before requesting approval.",
			};
		const selection = candidateId ?? r.view.selectedId;
		const candidate = r.view.candidates.find((item) => item.id === selection);
		if (!candidate) throw Error("Choose one of the displayed accounts before requesting approval.");
		const reviewId = crypto.randomUUID();
		const expires = Math.min(r.expiresAt, Date.now() + 5 * 60_000);
		this.chatReviews.set(reviewId, {
			requestId: id,
			clientId,
			candidate: structuredClone(candidate),
			scopeRevision: browserProviders[r.provider].revision,
			scopes: JSON.stringify(r.view.scopes),
			expires,
		});
		return {
			view: r.view,
			reviewId,
			account: candidate.identity,
			profile: candidate.profileLabel,
			expiresAt: new Date(expires).toISOString(),
			instructions:
				"Show the selected account, browser profile and every requested scope. Ask the user to reply approve. Stop and wait for that explicit reply before calling local_connectors_browser_confirm with this requestId, reviewId and confirmed:true. A setup request alone is not approval. Never reuse a reply for a different or expired review.",
		};
	}
	async confirmChat(id: string, clientId: string, reviewId: string, confirmed: boolean) {
		const r = this.get(id, clientId);
		const review = this.chatReviews.get(reviewId);
		if (!confirmed || !review || review.requestId !== id || review.clientId !== clientId)
			throw Error("Explicit approval of this chat review is required.");
		this.chatReviews.delete(reviewId);
		if (
			review.expires <= Date.now() ||
			r.terminal ||
			r.view.state !== "approval_required" ||
			review.scopeRevision !== browserProviders[r.provider].revision ||
			review.scopes !== JSON.stringify(r.view.scopes) ||
			!r.view.candidates.some((c) => JSON.stringify(c) === JSON.stringify(review.candidate))
		)
			throw Error(
				"The review expired or the account or access changed. Ask the user to review again.",
			);
		// The existing approval path independently rechecks live browser identity,
		// permissions and expiry before persisting consent or authorizing execution.
		const capability = this.review(id, clientId).capabilities[review.candidate.id];
		if (!capability) throw Error("The account is no longer available.");
		return this.approve(id, clientId, capability);
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
	async cancelByServer(serverId: string, clientId: string) {
		for (const r of this.requests.values())
			if (
				r.serverId === serverId &&
				!r.terminal &&
				(clientId === "desktop" || r.clientId === clientId)
			)
				await this.cancel(r.id, clientId);
		await this.store.mutate((state) => {
			state.grants = state.grants.filter(
				(grant) =>
					grant.serverId !== serverId || (clientId !== "desktop" && grant.clientId !== clientId),
			);
		});
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
							// Standalone clients can coexist. A disconnect in any process must
							// revoke passive access in every process before its next check.
							if (
								r.consent &&
								!(await this.store.read()).grants.some(
									(g) =>
										g.serverId === r.serverId &&
										g.clientId === r.clientId &&
										g.scopeRevision === r.consent!.scopeRevision &&
										g.candidate.profileId === r.consent!.candidate.profileId &&
										identityKey(g.candidate.identity) ===
											identityKey(r.consent!.candidate.identity),
								)
							) {
								await this.cancel(r.id, "desktop", false);
								return;
							}
							if (sessionRecoveryEnabled() && (r.nextRetryAt ?? 0) > Date.now()) return;
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
								if (sessionRecoveryEnabled()) {
									if (r.recoveryAttempts) this.recordRecovery(r, "recovered");
									r.recoveryAttempts = 0;
									r.view.recovery = undefined;
									this.update(
										r,
										"connected",
										"Connected. Closing the tab pauses access; reopen it to reconnect this account.",
									);
									r.nextRetryAt = undefined;
									r.recoveryStartedAt = undefined;
								}
								return;
							}
							if (sessionRecoveryEnabled()) r.verified = false;
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
											? "Sign in using the service link in your existing Chrome profile. This request will detect the account; closed tabs stay closed until you open them."
											: "Looking for the browser extension. Check that it is installed and Chrome is running.",
							);
						} catch (error) {
							if (sessionRecoveryEnabled() && !r.terminal) {
								const status = classifyRecovery(error);
								r.recoveryStartedAt ??= Date.now();
								r.nextRetryAt = Date.now() + recoveryDelay(r.recoveryAttempts ?? 0);
								r.recoveryAttempts = (r.recoveryAttempts ?? 0) + 1;
								r.view.recovery = { ...status, nextRetryAt: new Date(r.nextRetryAt).toISOString() };
								this.recordRecovery(r, status.reason);
								this.update(r, "disconnected", recoveryMessage(status));
								return;
							}
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
