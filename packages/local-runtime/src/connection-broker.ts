import { createHash, randomBytes, randomUUID } from "node:crypto";

import { EncryptedStore } from "@repo/local-mcp-core/encrypted-store";
import type { EntryFactory } from "@repo/local-mcp-core/store";
import {
	brokerCommand,
	brokerSession,
	type BrokerSession,
	type BrokerReadiness,
	type BrokerItem,
	type CredentialCandidate,
	type BrokerCommand,
} from "@repo/project-protocol/credential-broker";
import { canonicalJson } from "@repo/project-protocol/local-mcp";
import { z } from "zod";

import type { CredentialPrincipal } from "./credentials";

export interface BrokerExecution {
	state: BrokerItem["state"];
	message?: string;
	operationId?: string;
	browserTargetId?: string;
	expectedAccountId?: string;
	connectorId?: string;
}
export interface ConnectionBrokerAdapter {
	authorize(principal: CredentialPrincipal): Promise<void>;
	epoch(): string;
	scope?(): { accountId?: string; installationId?: string };
	candidates(
		principal: CredentialPrincipal,
		session: BrokerSession,
	): Promise<CredentialCandidate[]>;
	validate(principal: CredentialPrincipal, session: BrokerSession, item: BrokerItem): Promise<void>;
	execute(
		principal: CredentialPrincipal,
		session: BrokerSession,
		item: BrokerItem,
		signal: AbortSignal,
	): Promise<BrokerExecution>;
	browser(
		principal: CredentialPrincipal,
		session: BrokerSession,
		item: BrokerItem,
		command: Extract<BrokerCommand, { action: "browser" }>,
		signal: AbortSignal,
	): Promise<BrokerExecution & { observation?: unknown }>;
	cancel?(session: BrokerSession): Promise<void>;
	focus(section?: "servers" | "settings" | "device" | "clients" | "credentials"): void;
	unlock?(sessionId: string): void;
	readiness?(principal: CredentialPrincipal, session: BrokerSession): BrokerReadiness;
	prepare?(principal: CredentialPrincipal, session: BrokerSession): Promise<void>;
	automatic?: boolean;
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const active = (item: BrokerItem) =>
	["running", "verifying", "user_action_required"].includes(item.state);
const terminal = (item: BrokerItem) => ["connected", "cancelled", "expired"].includes(item.state);
/** One helper owns sessions; persisted intent precedes any credential side effect. */
export class ConnectionBroker {
	private store: EncryptedStore<Record<string, BrokerSession>>;
	private sessions: Record<string, BrokerSession> = {};
	async authorizeAssistant(id: string, authorize: (p: CredentialPrincipal) => Promise<void>) {
		const p = this.principals.get(id);
		if (!p) throw Error("Assistant unavailable.");
		await this.adapter.authorize(p);
		await authorize(p);
	}
	private principals = new Map<string, CredentialPrincipal>();
	async callFromDesktop(id: string, raw: unknown, requestId: string) {
		const principal = this.principals.get(id);
		if (!principal) throw Error("Ask your assistant to refresh this session.");
		return this.call(principal, raw, requestId);
	}
	private capabilities = new Map<
		string,
		{ sessionId: string; principalId: string; revision: number; epoch: string; expires: number }
	>();
	private grants = new Map<string, { revision: number; epoch: string; items: Set<string> }>();
	private controllers = new Map<string, AbortController>();
	private metrics = new Map<string, string>();
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		root: string,
		private adapter: ConnectionBrokerAdapter,
		private changed: () => void,
		entries?: EntryFactory,
	) {
		this.store = new EncryptedStore(
			root,
			"connection-broker",
			z.record(z.string(), brokerSession),
			() => ({}),
			entries,
		);
	}
	async initialize() {
		this.sessions = await this.store.read();
		for (const session of Object.values(this.sessions)) {
			for (const item of session.items)
				if (active(item)) {
					item.state = "failed";
					item.message =
						"Interrupted. Check the connection before starting a new attempt; no action was replayed.";
				}
			session.revision++;
		}
		await this.save();
	}
	private save() {
		for (const session of Object.values(this.sessions))
			for (const item of session.items) {
				const key = session.id + ":" + item.target.id;
				if (this.metrics.get(key) !== item.state) {
					this.metrics.set(key, item.state);
					console.info(
						JSON.stringify({
							event: "credential_broker_transition",
							state: item.state,
							location: item.target.location,
						}),
					);
				}
			}
		const value = structuredClone(this.sessions);
		return this.store.mutate((state) => {
			Object.keys(state).forEach((k) => delete state[k]);
			Object.assign(state, value);
		});
	}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const task = this.queue.catch(() => {}).then(work);
		this.queue = task;
		return task;
	}
	private async get(principal: CredentialPrincipal, id: string) {
		const session = this.sessions[id];
		const scope = this.adapter.scope?.() ?? {};
		// An unlinked, untouched draft has no destination account yet. Bind it once
		// after the user's native account-link action; never move a reviewed request.
		if (
			session &&
			session.principalId === principal.id &&
			!session.accountId &&
			scope.accountId &&
			(!session.installationId || session.installationId === scope.installationId) &&
			Object.keys(session.receipts).length === 0 &&
			session.items.every((i) => i.state === "matching" && !i.attempted && i.matches.length === 0)
		) {
			this.revoke(id);
			session.accountId = scope.accountId;
			session.installationId = scope.installationId;
			session.revision++;
			await this.save();
		}
		if (
			!session ||
			session.principalId !== principal.id ||
			session.accountId !== scope.accountId ||
			session.installationId !== scope.installationId
		)
			throw Error("Broker session unavailable.");
		if (session.expiresAt <= Date.now()) {
			this.revoke(id);
			session.items.forEach((item) => {
				if (!terminal(item)) item.state = "expired";
			});
		}
		return session;
	}
	private revoke(id: string) {
		this.grants.delete(id);
		this.controllers.get(id)?.abort();
		this.controllers.delete(id);
		for (const [key, value] of this.capabilities)
			if (value.sessionId === id) this.capabilities.delete(key);
	}
	invalidate() {
		for (const id of this.grants.keys()) {
			this.revoke(id);
			const session = this.sessions[id];
			if (!session) continue;
			session.revision++;
			for (const item of session.items)
				if (active(item)) {
					item.state = "review_required";
					item.message = item.attempted
						? "Access changed. Review to inspect or resume; credentials will not be submitted again."
						: "Access changed. Review again before connecting.";
				}
		}
		this.capabilities.clear();
		void this.serial(async () => {
			await this.save();
			this.changed();
		});
	}
	private view(session: BrokerSession) {
		const { receipts: _, principalId: __, ...view } = structuredClone(session);
		return {
			...view,
			workflowVersion: this.adapter.automatic ? 2 : undefined,
			readiness: this.principals.has(session.principalId)
				? this.adapter.readiness?.(this.principals.get(session.principalId)!, session)
				: undefined,
		};
	}
	pendingCount() {
		return Object.values(this.sessions).filter(
			(s) =>
				s.expiresAt > Date.now() &&
				s.items.some((i) =>
					["matching", "review_required", "user_action_required"].includes(i.state),
				),
		).length;
	}
	async shutdown() {
		for (const id of this.controllers.keys()) this.revoke(id);
		await this.queue.catch(() => {});
	}
	list() {
		const scope = this.adapter.scope?.() ?? {};
		return Object.values(this.sessions)
			.filter((s) => s.accountId === scope.accountId && s.installationId === scope.installationId)
			.map((s) => ({
				principalId: s.principalId,
				principalName: this.principals.get(s.principalId)?.name ?? "Connected assistant",
				...this.view(s),
			}));
	}
	async call(principal: CredentialPrincipal, raw: unknown, requestId: string) {
		const command = brokerCommand.parse(raw);
		await this.adapter.authorize(principal);
		this.principals.set(principal.id, principal);
		return this.serial(async () => {
			if (command.action === "start") {
				const existing = this.sessions[command.sessionId];
				if (existing) {
					const session = await this.get(principal, command.sessionId);
					await this.adapter.prepare?.(principal, session);
					if (digest(session.items.map((i) => i.target)) !== digest(command.targets))
						throw Error("Session ID already used.");
					return { view: this.view(session) };
				}
				if (new Set(command.targets.map((t) => t.id)).size !== command.targets.length)
					throw Error("Duplicate targets.");
				for (const [id, old] of Object.entries(this.sessions))
					if (old.expiresAt < Date.now() - 30 * 86400000) {
						this.revoke(id);
						delete this.sessions[id];
					}
				if (Object.keys(this.sessions).length >= 200) throw Error("Broker history full.");
				const session: BrokerSession = {
					...this.adapter.scope?.(),
					id: command.sessionId,
					principalId: principal.id,
					revision: 0,
					createdAt: Date.now(),
					expiresAt: Date.now() + 15 * 60000,
					items: command.targets.map((target) => ({
						target,
						matches: [],
						state: "matching",
						message: "Choose a credential match.",
					})),
					receipts: {},
				};
				// Prior references are suggestions only. They need current discovery and a new proposal/approval.
				for (const item of session.items)
					if (item.target.connectionId) {
						const previous = Object.values(this.sessions)
							.filter(
								(s) =>
									s.principalId === principal.id &&
									s.accountId === session.accountId &&
									s.installationId === session.installationId,
							)
							.sort((a, b) => b.createdAt - a.createdAt)
							.flatMap((s) => s.items)
							.find(
								(i) =>
									i.state === "connected" &&
									(i.connectorId ?? i.target.connectionId) === item.target.connectionId &&
									i.target.service === item.target.service,
							);
						if (previous) {
							item.matches = structuredClone(previous.matches);
							item.message =
								"Previous credential references found. Revalidate the match before review.";
						}
					}
				this.sessions[session.id] = session;
				await this.adapter.prepare?.(principal, session);
				await this.save();
				this.changed();
				return { view: this.view(session) };
			}
			const session = await this.get(principal, command.sessionId);
			if (command.action === "match") {
				const item = session.items.find((i) => i.target.id === command.itemId);
				if (!item || terminal(item) || (item.matches.length && item.attempted))
					throw Error("Use a new reviewed attempt.");
				if (session.items.some((i) => i !== item && active(i)))
					throw Error("Finish the active login first.");
				this.revoke(session.id);
				item.credentialRequested = true;
				item.state = "matching";
				item.message = "Choose a saved credential, then approve this connection.";
				session.revision++;
				await this.save();
				this.changed();
				return { view: this.view(session) };
			}
			if (command.action === "cancel") {
				this.revoke(session.id);
				await this.adapter.cancel?.(session).catch(() => {});
				session.revision++;
				session.items.forEach((item) => {
					if (!terminal(item)) {
						item.state = "cancelled";
						item.message = "Cancelled. Completed steps cannot be undone.";
					}
				});
				await this.save();
				this.changed();
				return { view: this.view(session) };
			}
			if (command.action === "unlock") {
				this.adapter.unlock?.(session.id);
				return { view: this.view(session) };
			}
			if (command.action === "status" || command.action === "review") {
				await this.adapter.prepare?.(principal, session);
				for (const item of session.items.filter(
					(i) => i.state === "matching" && i.matches.length,
				)) {
					try {
						await this.validateReviewed(principal, session, item);
						item.state = "review_required";
						item.message = "Review the saved match for this connection.";
						session.revision++;
						await this.save();
					} catch {
						/* Readiness explains the required local step. */
					}
				}
				if (command.action === "status") return { view: this.view(session) };
			}
			if (command.action === "desktop") {
				const readiness = this.adapter.readiness?.(principal, session);
				this.adapter.focus(
					readiness?.code === "manual_setup"
						? "servers"
						: readiness?.code === "authorize_management"
							? "clients"
							: readiness?.code === "link_account"
								? "settings"
								: readiness &&
									  ["connect_vault", "authorize_assistant", "enable_chrome"].includes(
											readiness.code,
									  )
									? "credentials"
									: undefined,
				);
				return { view: this.view(session) };
			}
			if (session.expiresAt <= Date.now()) throw Error("Broker session expired.");
			if (command.action === "candidates") {
				const candidates = await this.adapter.candidates(principal, session);
				const filtered = candidates.filter((c) =>
					(c.label + " " + (c.origins ?? []).join(" "))
						.toLowerCase()
						.includes(command.query.toLowerCase()),
				);
				return {
					view: this.view(session),
					candidates: filtered.slice(command.cursor, command.cursor + 50),
					nextCursor: command.cursor + 50 < filtered.length ? command.cursor + 50 : undefined,
				};
			}
			if (command.action === "review") {
				const capability = randomBytes(32).toString("base64url");
				for (const [key, value] of this.capabilities)
					if (value.expires < Date.now() || value.sessionId === session.id)
						this.capabilities.delete(key);
				this.capabilities.set(capability, {
					sessionId: session.id,
					principalId: principal.id,
					revision: session.revision,
					epoch: this.adapter.epoch(),
					expires: Date.now() + 60000,
				});
				return { view: this.view(session), capability };
			}
			const fingerprint = digest(command);
			if (session.receipts[requestId]) {
				if (session.receipts[requestId] !== fingerprint)
					throw Error("Request ID already used for different input.");
				return { view: this.view(session) };
			}
			if (command.action === "propose") {
				if (session.items.some(active)) throw Error("Finish or cancel the active attempt first.");
				const item = session.items.find((i) => i.target.id === command.itemId);
				if (!item || terminal(item) || (item.attempted && item.matches.length > 0))
					throw Error(
						"Item unavailable. Use a new session to change a previously executed mapping.",
					);
				if (new Set(command.matches.map((m) => m.field)).size !== command.matches.length)
					throw Error("Duplicate fields.");
				const candidate = { ...item, matches: command.matches };
				await this.adapter.validate(principal, session, candidate);
				this.revoke(session.id);
				session.revision++;
				const candidates = await this.adapter.candidates(principal, session);
				item.matches = command.matches.map((m) => {
					const c = candidates.find((c) => digest(c.source) === digest(m.source));
					if (!c) throw Error("Credential candidate disappeared.");
					return { ...m, label: c.label, origins: c.origins };
				});
				item.state = "review_required";
				item.message = "Review the credential source and destination.";
				session.receipts[requestId] = fingerprint;
				await this.save();
				this.changed();
				return { view: this.view(session) };
			}
			if (command.action === "approve" || command.action === "connect") {
				const cap = this.capabilities.get(command.capability);
				this.capabilities.delete(command.capability);
				if (
					!cap ||
					cap.sessionId !== session.id ||
					cap.principalId !== principal.id ||
					cap.revision !== session.revision ||
					cap.epoch !== this.adapter.epoch() ||
					cap.expires <= Date.now()
				)
					throw Error("Review changed or expired.");
				if (Object.values(this.sessions).some((s) => s.items.some(active)))
					throw Error("Finish the active login or connection first.");
				const ids = new Set(command.itemIds);
				if (ids.size !== command.itemIds.length) throw Error("Duplicate selection.");
				const selected = session.items.filter((i) => ids.has(i.target.id));
				if (
					selected.length !== ids.size ||
					selected.some((i) =>
						command.action === "connect"
							? i.state !== "matching" ||
								i.target.authType !== "oauth2" ||
								i.target.location !== "cloud" ||
								i.matches.length > 0 ||
								i.attempted
							: i.state !== "review_required",
					)
				)
					throw Error("Review the selected items again.");
				for (const item of selected) await this.validateReviewed(principal, session, item);
				if (cap.epoch !== this.adapter.epoch()) throw Error("Credential access changed.");
				this.grants.set(session.id, { revision: session.revision, epoch: cap.epoch, items: ids });
				session.receipts[requestId] = fingerprint;
				selected.forEach((i) => {
					i.state = "running";
					i.message =
						i.target.authType === "oauth2" ? "Approved. Opening Chrome…" : "Approved. Connecting…";
				});
				await this.save();
				const controller = new AbortController();
				this.controllers.set(session.id, controller);
				void this.run(principal, session, selected, controller).catch(() => {
					this.revoke(session.id);
				});
				this.changed();
				return { view: this.view(session) };
			}
			if (command.action === "browser") {
				const item = session.items.find((i) => i.target.id === command.itemId);
				if (!item || !active(item)) throw Error("Login unavailable.");
				this.checkGrant(session, item);
				await this.validateReviewed(principal, session, item);
				const controller = this.controllers.get(session.id) ?? new AbortController();
				this.controllers.set(session.id, controller);
				// Receipts and page revisions precede execution; a new request ID cannot replay a submission.
				if (command.operation === "advance") {
					if (
						item.submissionUncertain ||
						!command.pageRevision ||
						(item.submittedPages ?? []).includes(command.pageRevision) ||
						(item.submittedPages?.length ?? 0) >= 32
					)
						throw Error("This page was already submitted or needs a new review.");
					item.submittedPages = [...(item.submittedPages ?? []), command.pageRevision];
				}
				session.receipts[requestId] = fingerprint;
				await this.save();
				let result: Awaited<ReturnType<ConnectionBrokerAdapter["browser"]>>;
				try {
					result = await this.adapter.browser(principal, session, item, command, controller.signal);
				} catch {
					if (command.operation === "advance") {
						item.submissionUncertain = true;
						item.message =
							"Sign-in outcome is uncertain. Complete it in Chrome; only verification will continue.";
						await this.save();
						this.changed();
					}
					throw Error("Browser step unavailable. Check Chrome before a new attempt.");
				}
				this.checkGrant(session, item);
				const { observation, ...execution } = result;
				Object.assign(item, execution);
				await this.save();
				this.changed();
				if (item.state === "connected" || item.state === "failed") {
					const waiting = session.items.filter((i) => i.state === "running");
					if (waiting.length)
						void this.run(principal, session, waiting, controller).catch(() =>
							this.revoke(session.id),
						);
				}
				return { view: this.view(session), observation };
			}
			throw Error("Unsupported broker command.");
		});
	}
	private async validateReviewed(
		principal: CredentialPrincipal,
		session: BrokerSession,
		item: BrokerItem,
	) {
		await this.adapter.validate(principal, session, item);
		if (!item.matches.length && item.target.authType === "oauth2") return;
		const candidates = await this.adapter.candidates(principal, session);
		for (const match of item.matches) {
			const current = candidates.find((c) => digest(c.source) === digest(match.source));
			if (
				!current ||
				current.label !== match.label ||
				digest([...(current.origins ?? [])].sort()) !== digest([...(match.origins ?? [])].sort())
			) {
				this.invalidate();
				session.revision++;
				if (!item.attempted) item.state = "matching";
				item.message = "Credential metadata changed. Propose a current match and review again.";
				await this.save();
				throw Error("Credential metadata changed.");
			}
		}
	}
	private checkGrant(session: BrokerSession, item: BrokerItem) {
		const grant = this.grants.get(session.id);
		if (
			!grant ||
			grant.revision !== session.revision ||
			grant.epoch !== this.adapter.epoch() ||
			!grant.items.has(item.target.id) ||
			session.expiresAt <= Date.now()
		) {
			this.invalidate();
			throw Error("Approval expired. Review again.");
		}
	}
	private async run(
		principal: CredentialPrincipal,
		session: BrokerSession,
		items: BrokerItem[],
		controller: AbortController,
	) {
		for (const item of items) {
			if (controller.signal.aborted) break;
			try {
				await this.adapter.authorize(principal);
				this.checkGrant(session, item);
				await this.validateReviewed(principal, session, item);
				// Persist an attempt before any external effect. Reapproval may inspect/resume, never replay.
				let result: BrokerExecution;
				if (item.attempted)
					result = {
						state: "user_action_required",
						message: "Review renewed. Inspect the login or verify its outcome.",
					};
				else {
					item.attempted = true;
					await this.serial(() => this.save());
					controller.signal.throwIfAborted();
					result = await this.adapter.execute(principal, session, item, controller.signal);
				}
				if (item.state === "review_required" || item.state === "cancelled") {
					for (const key of ["operationId", "connectorId", "browserTargetId"] as const)
						if (result[key]) item[key] = result[key];
				}
				this.checkGrant(session, item);
				if (item.state !== "cancelled") Object.assign(item, result);
			} catch {
				if (item.state !== "cancelled" && item.state !== "review_required") {
					item.state = "failed";
					item.message =
						"Connection could not be confirmed. Check its status before a new attempt.";
				}
			}
			await this.serial(async () => {
				await this.save();
				this.changed();
			});
			// The approved executor owns continuation. Browser items remain serial.
			if (item.state === "user_action_required") {
				for (const pending of items.slice(items.indexOf(item) + 1)) {
					pending.message = "Approved. Waiting for the current login.";
				}
				await this.serial(() => this.save());
				if (this.adapter.automatic) void this.follow(principal, session, item, controller);
				break;
			}
		}
	}
	private async follow(
		principal: CredentialPrincipal,
		session: BrokerSession,
		item: BrokerItem,
		controller: AbortController,
	) {
		// All side effects pass through call(): authorization, revision checks and durable receipts.
		let uncertain = !!item.submissionUncertain;
		while (!controller.signal.aborted && active(item) && Date.now() < session.expiresAt) {
			await new Promise((resolve) => setTimeout(resolve, 2500));
			if (controller.signal.aborted || !active(item)) break;
			try {
				await this.call(
					principal,
					{ action: "browser", sessionId: session.id, itemId: item.target.id, operation: "verify" },
					randomUUID(),
				);
				if (!active(item) || !item.browserTargetId || uncertain) continue;
				const result = await this.call(
					principal,
					{
						action: "browser",
						sessionId: session.id,
						itemId: item.target.id,
						operation: "inspect",
					},
					randomUUID(),
				);
				const observation = (result as { observation?: { handoff: boolean; revision: string } })
					.observation;
				if (!observation || observation.handoff) continue;
				if (!item.matches.length) {
					await this.serial(async () => {
						item.state = "matching";
						item.message = "Chrome needs a login. Choose a saved credential and approve it here.";
						await this.save();
						this.changed();
					});
					break;
				}
				if (item.submittedPages?.includes(observation.revision)) continue;
				try {
					await this.call(
						principal,
						{
							action: "browser",
							sessionId: session.id,
							itemId: item.target.id,
							operation: "advance",
							pageRevision: observation.revision,
						},
						randomUUID(),
					);
				} catch {
					uncertain = true;
					throw Error("Submission uncertain.");
				}
			} catch {
				// Never repeat a failed/uncertain submission. Verification may still complete.
				if (!controller.signal.aborted && active(item)) {
					item.message =
						"Continue in Chrome. Laplace will check the connection; no uncertain sign-in step is repeated.";
					await this.serial(async () => {
						await this.save();
						this.changed();
					});
				}
			}
		}
		if (Date.now() >= session.expiresAt) {
			this.revoke(session.id);
			if (active(item)) item.state = "expired";
			await this.serial(async () => {
				await this.save();
				this.changed();
			});
		}
	}
}
