import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { EncryptedStore } from "@repo/local-mcp-core/encrypted-store";
import type { EntryFactory } from "@repo/local-mcp-core/store";
import {
	credentialInput,
	MAX_CREDENTIAL_BINDINGS,
	credentialSettings,
	type CredentialInput,
	type CredentialAction,
	type CredentialSettings,
} from "@repo/project-protocol/credentials";
import { canonicalJson } from "@repo/project-protocol/local-mcp";
import { z } from "zod";

import type { BitwardenConnection, CredentialBrowserState } from "../shared/credential-setup";
import { BitwardenConnectionManager } from "./bitwarden-connection";
import { BrokerChrome } from "./broker-chrome";
import { CredentialBrowser } from "./credential-browser";
import { CredentialSetupError } from "./credential-errors";
import { browserTargets, cdpOrigin, fillBrowser } from "./credentials-cdp";
import {
	bitwardenCommand,
	executeCommand,
	executeHttp,
	validateParameters,
} from "./credentials-execution";

export type CredentialPrincipal = {
	id: string;
	name: string;
	hosted: boolean;
	authorize: () => void | Promise<void>;
};
type Operation = {
	id: string;
	principal: CredentialPrincipal;
	input: CredentialInput;
	fingerprint: string;
	state: "pending" | "running" | "complete" | "denied" | "cancelled" | "failed" | "expired";
	scope: string;
	summary: string;
	expires: number;
	epoch: number;
	controller: AbortController;
	result?: unknown;
};
export type CredentialSnapshot = {
	connection: BitwardenConnection;
	browser: CredentialBrowserState;
	hostedState: "disabled" | "checking" | "ready" | "unavailable";
	settings: CredentialSettings;
	unlocked: boolean;
	pending: Array<{
		oneTimeOnly?: boolean;
		id: string;
		principalId: string;
		client: string;
		summary: string;
		expiresAt: string;
	}>;
	grants: Array<{ scope: string; expiresAt: string }>;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const errorResult = {
	error:
		"Credential operation failed or was interrupted. Check Laplace Desktop; do not automatically retry an uncertain operation.",
};

export class CredentialBroker {
	connectionBroker?: import("./connection-broker").ConnectionBroker;
	private brokerResults = new Map<
		string,
		{ fingerprint: string; result: unknown; createdAt: number }
	>();
	isBrokerRequest(principal: CredentialPrincipal, id: string) {
		return this.brokerResults.has(principal.id + ":" + id);
	}

	readonly connection: BitwardenConnectionManager;
	readonly browser: CredentialBrowser;
	readonly brokerBrowser: CredentialBrowser;
	readonly brokerChrome: BrokerChrome;
	hostedState: CredentialSnapshot["hostedState"] = "disabled";
	private settings = credentialSettings.parse({});
	private store: EncryptedStore<CredentialSettings>;
	private session?: string;
	private unlockedUntil = 0;
	private epoch = 0;
	private operations = new Map<string, Operation>();
	private grants = new Map<string, number>();
	private journal: EncryptedStore<Record<string, { hash: string; at: number }>>;
	private seen: Record<string, { hash: string; at: number }> = {};
	private timer: ReturnType<typeof setInterval>;
	constructor(
		root: string,
		private resources: string,
		private changed: () => void,
		entries?: EntryFactory,
		private bw = bitwardenCommand,
		private executors = { browserTargets, fillBrowser, executeHttp, executeCommand },
	) {
		this.connection = new BitwardenConnectionManager(root, resources, changed);
		this.browser = new CredentialBrowser(root, resources, changed);
		this.brokerBrowser = new CredentialBrowser(join(root, "broker-browser"), resources, changed);
		this.brokerChrome = new BrokerChrome((url) => this.browser.openExistingChrome(url));
		this.store = new EncryptedStore(
			root,
			"credentials",
			credentialSettings,
			() => credentialSettings.parse({}),
			entries,
		);
		this.journal = new EncryptedStore(
			root,
			"credential-requests",
			z.record(z.string(), z.object({ hash: z.string(), at: z.number() })),
			() => ({}),
			entries,
		);
		this.timer = setInterval(() => this.sweep(), 1000);
		this.timer.unref();
	}
	async initialize() {
		this.settings = await this.store.read();
		this.seen = await this.journal.read();
	}
	private sweep() {
		if (this.session && Date.now() >= this.unlockedUntil) this.lock();
		let changed = false;
		for (const [key, op] of this.operations) {
			if (op.expires < Date.now() && ["pending", "running"].includes(op.state)) {
				op.state = "expired";
				op.controller.abort();
				changed = true;
			}
			if (op.expires + 600000 < Date.now()) this.operations.delete(key);
		}
		for (const [key, at] of this.grants)
			if (at < Date.now()) {
				this.grants.delete(key);
				changed = true;
			}
		if (changed) this.changed();
	}
	snapshot(): CredentialSnapshot {
		return {
			connection: this.connection.snapshot(),
			browser: this.browser.state(),
			hostedState: this.settings.hosted ? this.hostedState : "disabled",
			settings: structuredClone(this.settings),
			unlocked: !!this.session && Date.now() < this.unlockedUntil,
			pending: [...this.operations.values()]
				.filter((op) => op.state === "pending")
				.map((op) => ({
					id: op.id,
					principalId: op.principal.id,
					client: op.principal.name,
					summary: op.summary,
					oneTimeOnly: op.input.action === "run_command",
					expiresAt: new Date(op.expires).toISOString(),
				})),
			grants: [...this.grants].map(([scope, at]) => ({
				scope,
				expiresAt: new Date(at).toISOString(),
			})),
		};
	}
	async configure(raw: unknown, keepUnlocked = false) {
		const settings = credentialSettings.parse(raw);
		if (settings.bwPath !== "bw" && !isAbsolute(settings.bwPath))
			throw new Error("Select an absolute Bitwarden CLI path");
		if (settings.cdpEndpoint) cdpOrigin(settings.cdpEndpoint);
		for (const action of settings.actions)
			if (action.kind === "command" && (!isAbsolute(action.executable) || !isAbsolute(action.cwd)))
				throw new Error("Commands require absolute paths");
		const sameConnection =
			settings.bwPath === this.settings.bwPath &&
			settings.managedBitwarden === this.settings.managedBitwarden &&
			settings.bitwardenServer === this.settings.bitwardenServer;
		if (settings.hosted && !this.settings.hosted) this.hostedState = "checking";
		if (!keepUnlocked || !sameConnection || !settings.enabled) this.lock();
		else this.cancelApprovals();
		this.settings = await this.store.mutate((state) => {
			Object.assign(state, settings);
		});
		this.changed();
		return this.snapshot();
	}
	async connectionStatus() {
		await this.browser.health(this.settings.cdpEndpoint);
		return this.snapshot();
	}
	async initializeConnection() {
		await this.connection.initialize(
			this.settings.managedBitwarden,
			this.settings.bitwardenServer,
			this.settings.bwPath,
		);
	}
	async prepareConnection(server: string) {
		// Validate before downloading, and preserve existing selections until preparation succeeds.
		const next = credentialSettings.parse({
			...this.settings,
			enabled: true,
			managedBitwarden: true,
			bitwardenServer: server,
			setupStep: "signIn",
		});
		if (
			!this.settings.managedBitwarden &&
			this.settings.bindings.length &&
			!next.bitwardenAccountId
		) {
			try {
				const info = JSON.parse(
					await this.bw(this.settings.bwPath, ["status"], undefined, AbortSignal.timeout(10000)),
				);
				if (z.string().uuid().safeParse(info.userId).success) next.bitwardenAccountId = info.userId;
			} catch {
				/* Explicit migration still preserves the old selection; never imports an external session. */
			}
		}
		await this.connection.prepare();
		await this.configure(next);
		await this.connection.useManaged(server);
		return this.snapshot();
	}
	async signIn(input: {
		email: string;
		password: string;
		clientId?: string;
		clientSecret?: string;
		method?: string;
	}) {
		if (!this.settings.managedBitwarden || !this.settings.enabled)
			throw new CredentialSetupError("unavailable");
		this.lock();
		const epoch = this.epoch;
		await this.connection.signIn(input, async (session, accountId) => {
			if (epoch !== this.epoch) throw new CredentialSetupError("cancelled");
			if (
				this.settings.bindings.length &&
				this.settings.bitwardenAccountId &&
				this.settings.bitwardenAccountId !== accountId
			)
				throw new CredentialSetupError("account_mismatch");
			const validatedId = z.string().uuid().parse(accountId);
			this.settings = await this.store.mutate((s) => {
				s.bitwardenAccountId = validatedId;
				s.setupStep = "logins";
			});
			if (epoch !== this.epoch) throw new CredentialSetupError("cancelled");
			this.session = session;
			this.unlockedUntil = Date.now() + 15 * 60000;
			this.changed();
		});
		return this.snapshot();
	}
	async disconnectConnection() {
		this.lock();
		await this.browser.close();
		await this.brokerBrowser.close();
		if (this.settings.managedBitwarden) await this.connection.disconnect();
		await this.configure({
			...this.settings,
			enabled: false,
			setupComplete: false,
			setupStep: "connect",
			cdpEndpoint: "",
		});
		return this.snapshot();
	}
	async selectBrowser(id: string, launch: boolean) {
		const endpoint = launch ? await this.browser.launch(id) : await this.browser.select(id);
		await this.configure({ ...this.settings, cdpEndpoint: endpoint }, true);
		return this.snapshot();
	}
	private runBw(
		path: string,
		args: string[],
		session: string | undefined,
		signal: AbortSignal,
		master?: string,
	) {
		return this.settings.managedBitwarden
			? this.connection.command(args, session, signal, master)
			: this.bw(path, args, session, signal, master);
	}
	async unlock(master: string) {
		if (!this.settings.enabled) throw new Error("Enable Bitwarden access first");
		const epoch = this.epoch;
		const token = (
			await this.runBw(
				this.settings.bwPath,
				["unlock", "--raw", "--passwordenv", "LAPLACE_BW_MASTER"],
				undefined,
				AbortSignal.timeout(30000),
				master,
			).catch((error: unknown) => {
				if (error instanceof CredentialSetupError && error.code === "signed_out") {
					this.lock();
					this.connection.signedOut();
				}
				throw error;
			})
		).trim();
		if (epoch !== this.epoch || !token || token.length > 8192)
			throw new Error("Vault state changed; unlock again");
		if (this.settings.managedBitwarden) {
			const status = JSON.parse(await this.connection.command(["status"], token));
			const accountId = z.string().uuid().parse(status.userId);
			if (
				this.settings.bindings.length &&
				this.settings.bitwardenAccountId &&
				this.settings.bitwardenAccountId !== accountId
			)
				throw new CredentialSetupError("account_mismatch");
			if (epoch !== this.epoch) throw new CredentialSetupError("cancelled");
			this.settings = await this.store.mutate((s) => {
				s.bitwardenAccountId = accountId;
			});
			if (epoch !== this.epoch) throw new CredentialSetupError("cancelled");
			this.connection.connected(
				typeof status.userEmail === "string" ? status.userEmail : "Bitwarden",
			);
		}
		this.session = token;
		this.unlockedUntil = Date.now() + 15 * 60000;
		this.changed();
		return { unlocked: true };
	}
	lock() {
		this.connection.cancel();
		this.session = undefined;
		this.unlockedUntil = 0;
		this.cancelApprovals();
	}
	private cancelApprovals() {
		this.brokerChrome.close();
		this.brokerSyncAt = 0;
		this.connectionBroker?.invalidate();
		this.epoch++;
		this.grants.clear();
		for (const op of this.operations.values())
			if (["pending", "running"].includes(op.state)) {
				op.state = "cancelled";
				op.controller.abort();
			}
		this.changed();
	}
	revokeGrants() {
		this.lock();
		return { locked: true };
	}
	close() {
		clearInterval(this.timer);
		this.lock();
		void this.browser.close();
		void this.brokerBrowser.close();
		this.brokerChrome.shutdown();
	}
	revokePrincipal(id: string) {
		let changed = false;
		for (const op of this.operations.values())
			if (op.principal.id === id && ["pending", "running"].includes(op.state)) {
				op.state = "cancelled";
				op.controller.abort();
				changed = true;
			}
		for (const key of this.grants.keys())
			if (key.startsWith(`${id}:`)) {
				this.grants.delete(key);
				changed = true;
			}
		if (changed) this.changed();
	}
	allowed(principal: CredentialPrincipal) {
		return (
			this.settings.enabled &&
			(principal.hosted
				? this.settings.hosted
				: this.settings.clients.includes(principal.id.replace(/^local:/, "")))
		);
	}
	private async check(principal: CredentialPrincipal) {
		await principal.authorize();
		if (!this.allowed(principal))
			throw new Error("Enable credential access for this client in Laplace Desktop settings");
	}
	brokerAllowed(principal: CredentialPrincipal) {
		return (
			this.allowed(principal) &&
			(!principal.hosted || this.settings.brokerAssistants.some((p) => p.id === principal.id))
		);
	}
	async authorizeBrokerAssistant(principal: CredentialPrincipal) {
		await this.check(principal);
		if (!principal.hosted) return;
		if (!this.settings.brokerAssistants.some((p) => p.id === principal.id))
			await this.configure(
				{
					...this.settings,
					brokerAssistants: [
						...this.settings.brokerAssistants,
						{ id: principal.id, name: principal.name },
					],
				},
				true,
			);
	}
	get brokerEpoch() {
		this.sweep();
		return String(this.epoch);
	}
	private brokerSyncAt = 0;
	private brokerSync: Promise<void> | undefined;
	async brokerCandidates(principal: CredentialPrincipal) {
		await this.check(principal);
		if (!this.brokerAllowed(principal))
			throw Error("Authorize this assistant for matching in Desktop.");
		this.requireUnlocked();
		if (!this.settings.wholeVaultMatching)
			return this.settings.bindings.map((b) => ({ id: b.id, label: b.label, origins: b.origins }));
		// Bitwarden CLI vault reads use its local cache. Refresh bounded metadata discovery.
		if (Date.now() - this.brokerSyncAt > 30000) {
			if (!this.brokerSync) {
				const epoch = this.epoch;
				this.brokerSync = this.runBw(
					this.settings.bwPath,
					["sync"],
					this.requireUnlocked(),
					AbortSignal.timeout(30000),
				)
					.then(() => {
						if (epoch !== this.epoch) throw Error("Vault locked.");
						this.brokerSyncAt = Date.now();
					})
					.finally(() => {
						this.brokerSync = undefined;
					});
			}
			await this.brokerSync;
			await this.check(principal);
			this.requireUnlocked();
		}
		return this.items(10000);
	}
	async withBrokerLogin<T>(
		principal: CredentialPrincipal,
		id: string,
		origin: string,
		use: (values: Record<string, string>) => Promise<T>,
	): Promise<T> {
		await this.check(principal);
		if (!this.brokerAllowed(principal)) throw Error("Assistant matching access revoked.");
		const epoch = this.epoch;
		const binding = this.settings.bindings.find((b) => b.id === id);
		if (!binding && !this.settings.wholeVaultMatching) throw Error("Credential not selected.");
		const item = JSON.parse(
			await this.runBw(
				this.settings.bwPath,
				["get", "item", binding?.itemId ?? id],
				this.requireUnlocked(),
				AbortSignal.timeout(30000),
			),
		);
		await this.check(principal);
		this.requireUnlocked();
		if (
			epoch !== this.epoch ||
			item.type !== 1 ||
			item.deletedDate ||
			!this.origins(item).includes(origin) ||
			(binding && !binding.origins.includes(origin))
		)
			throw Error("Credential destination changed.");
		const values: Record<string, string> = {};
		if (typeof item.login?.username === "string") values.username = item.login.username;
		if (typeof item.login?.password === "string") values.password = item.login.password;
		return use(values);
	}
	private requireUnlocked() {
		if (!this.session || Date.now() >= this.unlockedUntil)
			throw new CredentialSetupError("expired");
		return this.session;
	}
	async items(limit = MAX_CREDENTIAL_BINDINGS) {
		const session = this.requireUnlocked();
		const epoch = this.epoch;
		const raw: unknown = JSON.parse(
			await this.runBw(
				this.settings.bwPath,
				["list", "items"],
				session,
				AbortSignal.timeout(30000),
			),
		);
		if (epoch !== this.epoch) throw new Error("Vault locked");
		if (!Array.isArray(raw)) throw new Error("Invalid Bitwarden response");
		const logins = raw.filter((v) => v?.type === 1 && typeof v.id === "string" && !v.deletedDate);
		if (logins.length > limit) throw new CredentialSetupError("vault_limit");
		return logins.map((v) => ({
			id: String(v.id),
			label: String(v.name ?? "Login").slice(0, 100),
			origins: this.origins(v),
		}));
	}
	private origins(item: any): string[] {
		return (Array.isArray(item?.login?.uris) ? item.login.uris : []).flatMap((v: any) => {
			try {
				const u = new URL(v.uri);
				return v.match !== 5 && u.protocol === "https:" && !u.username && !u.password
					? [u.origin]
					: [];
			} catch {
				return [];
			}
		});
	}
	private binding(id: string) {
		const v = this.settings.bindings.find((b) => b.id === id);
		if (!v) throw new Error("Unknown credential handle");
		return v;
	}
	private action(id: string, kind: string) {
		const v = this.settings.actions.find((a) => a.id === id && a.kind === kind);
		if (!v) throw new Error("Unknown configured action");
		return v;
	}
	private command(
		input: Extract<CredentialInput, { action: "run_command" }>,
	): Extract<CredentialAction, { kind: "command" }> {
		if (!isAbsolute(input.command.executable) || !isAbsolute(input.command.cwd))
			throw Error("Use absolute executable and working-directory paths.");
		return {
			id: input.requestId,
			label: "One-time local command",
			kind: "command",
			credentialId: input.credentialId,
			parameters: {},
			resultFields: [],
			executable: input.command.executable,
			cwd: input.command.cwd,
			args: input.command.args,
			env: input.command.env,
		};
	}
	private describe(input: Exclude<CredentialInput, { action: "broker" }>): {
		scope: string;
		summary: string;
	} {
		if (input.action === "run_command") {
			const a = this.command(input),
				b = this.binding(input.credentialId);
			return {
				scope: input.requestId,
				summary:
					"Run once with " +
					b.label +
					": " +
					a.executable +
					" " +
					JSON.stringify(a.args) +
					" in " +
					a.cwd +
					". Credential fields → environment: " +
					JSON.stringify(a.env) +
					". Maximum runtime: " +
					input.command.runtimeSeconds +
					" seconds. This process receives the selected secrets; output is withheld.",
			};
		}
		if (input.action === "fill") {
			const b = this.binding(input.credentialId);
			return {
				scope: canonicalJson({
					action: "fill",
					credentialId: b.id,
					targetId: input.targetId,
					fields: [...new Set(input.fields)].sort(),
					origins: b.origins,
				}),
				summary: `Fill ${input.fields.join(", ")} for ${b.label} in tab ${input.targetId}. Allowed sites: ${b.origins.join(", ")}`,
			};
		}
		if (input.action === "http" || input.action === "run") {
			const a = this.action(input.actionId, input.action === "http" ? "http" : "command");
			validateParameters(a, input.parameters);
			return {
				scope: canonicalJson({
					action: input.action,
					actionId: a.id,
					parameters: input.parameters,
				}),
				summary: `${a.label}: ${a.kind === "http" ? `${a.method} ${a.url}` : `${a.executable} ${JSON.stringify(a.args)} in ${a.cwd}`} — parameters ${JSON.stringify(input.parameters)}`,
			};
		}
		return {
			scope: input.action,
			summary: `Read credential ${input.action === "list" ? "labels and configured actions" : input.action}`,
		};
	}
	async call(principal: CredentialPrincipal, raw: unknown): Promise<unknown> {
		this.sweep();
		await principal.authorize();
		const input = credentialInput.parse(raw);
		if (!principal.hosted && input.action === "status" && !this.allowed(principal))
			return {
				requestId: input.requestId,
				status: "complete",
				result: {
					ready: false,
					setupRequired: true,
					instructions:
						"Open Laplace Desktop → Credentials. Connect and unlock Bitwarden, select permitted credentials, and enable this assistant. Then call status again. Never send credentials in chat.",
				},
			};
		if (
			input.action !== "broker" &&
			!(
				(input.action === "result" || input.action === "cancel") &&
				this.isBrokerRequest(principal, input.requestId)
			)
		)
			await this.check(principal);
		if (principal.hosted && input.action === "run_command")
			throw Error("Command proposals require a locally registered assistant.");
		if (input.action === "devices") return { local: true };
		const key = `${principal.id}:${input.requestId}`;
		if (input.action === "broker") {
			if (!this.connectionBroker) throw Error("Update Desktop for credential brokering.");
			const fingerprint = hash(canonicalJson(input));
			for (const [id, value] of this.brokerResults)
				if (value.createdAt < Date.now() - 900000) this.brokerResults.delete(id);
			const old = this.brokerResults.get(key);
			if (old) {
				if (old.fingerprint !== fingerprint) throw Error("Request ID reused.");
				return old.result;
			}
			if (this.brokerResults.size >= 1000) throw Error("Broker request limit reached.");
			const record = {
				fingerprint,
				createdAt: Date.now(),
				result: { requestId: input.requestId, status: "running" } as unknown,
			};
			this.brokerResults.set(key, record);
			try {
				record.result = {
					requestId: input.requestId,
					status: "complete",
					result: await this.connectionBroker.call(principal, input.command, input.requestId),
				};
			} catch {
				record.result = {
					requestId: input.requestId,
					status: "failed",
					error: "Broker request failed. Check Desktop and review the current state.",
				};
			}
			return record.result;
		}
		if ((input.action === "result" || input.action === "cancel") && this.brokerResults.has(key))
			return this.brokerResults.get(key)!.result;
		const existing = this.operations.get(key);
		if (input.action === "result" || input.action === "cancel") {
			if (!existing) return { status: "unavailable", requestId: input.requestId };
			if (input.action === "cancel" && ["pending", "running"].includes(existing.state)) {
				existing.state = "cancelled";
				existing.controller.abort();
				this.changed();
			}
			return this.result(existing);
		}
		const fingerprint = hash(canonicalJson(input));
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				throw new Error("Request ID already used for different input");
			return this.result(existing);
		}
		if (this.seen[key]) {
			if (this.seen[key].hash !== fingerprint)
				throw new Error("Request ID already used for different input");
			return {
				requestId: input.requestId,
				status: "unavailable",
				error: "Previous request outcome unavailable; it will not be replayed.",
			};
		}
		if (this.operations.size >= 100)
			throw new Error("Too many credential requests; wait for older requests to expire");
		const description = this.describe(input);
		const op: Operation = {
			id: input.requestId,
			principal,
			input,
			fingerprint,
			state: "pending",
			scope: `${principal.id}:${description.scope}`,
			summary: description.summary,
			expires: Date.now() + 120000,
			epoch: this.epoch,
			controller: new AbortController(),
		};
		this.operations.set(key, op);
		try {
			this.seen = await this.journal.mutate((state) => {
				for (const [key, value] of Object.entries(state))
					if (value.at < Date.now() - 86400000) delete state[key];
				if (Object.keys(state).length >= 5000) throw new Error("Request history full");
				state[key] = { hash: fingerprint, at: Date.now() };
			});
		} catch {
			op.state = "failed";
			this.changed();
			return this.result(op);
		}
		if (op.epoch !== this.epoch || op.state !== "pending") return this.result(op);
		if (
			input.action === "status" ||
			(!principal.hosted && ["list", "targets"].includes(input.action))
		)
			await this.start(op);
		else if (input.action !== "run_command" && (this.grants.get(op.scope) ?? 0) > Date.now()) {
			op.state = "running";
			void this.start(op);
		}
		this.changed();
		return this.result(op);
	}
	private result(op: Operation) {
		return {
			requestId: op.id,
			status: op.state,
			...(op.state === "complete"
				? { result: op.result }
				: op.state === "failed"
					? errorResult
					: {}),
		};
	}
	async approve(principalId: string, id: string, allow: boolean, remember: boolean) {
		const op = this.operations.get(`${principalId}:${id}`);
		if (!op || op.state !== "pending" || op.expires < Date.now() || op.epoch !== this.epoch)
			throw new Error("Request expired or already decided");
		if (!allow) {
			op.state = "denied";
			this.changed();
			return { denied: true };
		}
		this.requireUnlocked();
		op.state = "running";
		try {
			await this.check(op.principal);
		} catch {
			op.state = "failed";
			this.changed();
			throw new Error("Client access revoked");
		}
		if (op.epoch !== this.epoch || op.state !== "running") throw new Error("Authorization changed");
		if (remember && op.input.action !== "run_command")
			this.grants.set(op.scope, Math.min(this.unlockedUntil, Date.now() + 15 * 60000));
		if (op.input.action === "run_command")
			op.expires = Math.min(
				this.unlockedUntil,
				Date.now() + op.input.command.runtimeSeconds * 1000,
			);
		// Mark running before yielding so repeated approvals cannot duplicate the operation.
		op.state = "running";
		this.changed();
		void this.start(op);
		return { approved: true };
	}
	private async start(op: Operation) {
		op.state = "running";
		try {
			await this.check(op.principal);
			if (op.epoch !== this.epoch) throw new Error();
			const signal = AbortSignal.any([
				op.controller.signal,
				AbortSignal.timeout(
					op.input.action === "run_command" ? op.input.command.runtimeSeconds * 1000 : 60000,
				),
			]);
			const result = await this.execute(op.input, signal, op);
			if (Buffer.byteLength(JSON.stringify(result)) > 48000)
				throw new Error("Result limit exceeded");
			if (op.state === "running" && op.epoch === this.epoch && !signal.aborted) {
				op.result = result;
				op.state = "complete";
			}
		} catch {
			if (op.state === "running") op.state = "failed";
		}
		this.changed();
	}
	private async execute(
		input: CredentialInput,
		signal: AbortSignal,
		op: Operation,
	): Promise<unknown> {
		if (input.action === "status")
			return {
				unlocked: !!this.session && Date.now() < this.unlockedUntil,
				brokerBrowserAutomatic: true,
				browserConfigured: !!this.settings.cdpEndpoint,
				browserAvailable: (await this.browser.health(this.settings.cdpEndpoint)).available,
				browserGuidance:
					"Hosted OAuth through local_credential_broker opens a sign-in tab in your normal Chrome profile through the Laplace extension. Allow requested site access in Chrome when prompted. No separate browser or debugging setup is used.",
				...(!op.principal.hosted && this.settings.cdpEndpoint
					? { browserEndpoint: this.settings.cdpEndpoint }
					: {}),
			};
		this.requireUnlocked();
		if (input.action === "list") {
			const credentials = this.settings.bindings.map((b) => ({
				id: b.id,
				label: b.label,
				origins: b.origins,
			}));
			const actions = this.settings.actions.map((a) => ({
				id: a.id,
				label: a.label,
				kind: a.kind,
				parameters: a.parameters,
			}));
			const offset = Number(input.cursor ?? 0);
			const total = credentials.length + actions.length;
			if (offset > total) throw new Error("List changed; restart from the first page");
			const page: {
				credentials: typeof credentials;
				actions: typeof actions;
				nextCursor?: string;
			} = { credentials: [], actions: [] };
			let index = offset;
			let bytes = 100;
			while (index < total && index - offset < 100) {
				const value =
					index < credentials.length ? credentials[index]! : actions[index - credentials.length]!;
				const size = Buffer.byteLength(JSON.stringify(value)) + 1;
				if (bytes + size > 40000) {
					if (index === offset) throw new Error("Credential metadata exceeds result limit");
					break;
				}
				if (index < credentials.length) page.credentials.push(credentials[index]!);
				else page.actions.push(actions[index - credentials.length]!);
				bytes += size;
				index++;
			}
			if (index < total) page.nextCursor = String(index);
			return page;
		}
		if (input.action === "targets")
			return (await this.executors.browserTargets(this.settings.cdpEndpoint, signal))
				.filter((t) => this.settings.bindings.some((b) => b.origins.includes(t.origin)))
				.map((t) => ({ id: t.id, origin: t.origin }));
		if (
			input.action !== "fill" &&
			input.action !== "http" &&
			input.action !== "run" &&
			input.action !== "run_command"
		)
			throw new Error("Unsupported operation");
		const action =
			input.action === "run_command"
				? this.command(input)
				: input.action !== "fill"
					? this.action(input.actionId, input.action === "http" ? "http" : "command")
					: undefined;
		const binding = this.binding(
			input.action === "fill" ? input.credentialId : action!.credentialId,
		);
		const item = JSON.parse(
			await this.runBw(
				this.settings.bwPath,
				["get", "item", binding.itemId],
				this.requireUnlocked(),
				signal,
			),
		);
		if (item.id !== binding.itemId) throw new Error("Credential mismatch");
		const field = async (name: string): Promise<string> => {
			let value: unknown;
			if (name === "totp")
				value = (
					await this.runBw(
						this.settings.bwPath,
						["get", "totp", binding.itemId],
						this.requireUnlocked(),
						signal,
					)
				).trim();
			else if (name.startsWith("custom:")) {
				const fields = (item.fields ?? []).filter((f: any) => f.name === name.slice(7));
				if (fields.length === 1) value = fields[0].value;
			} else value = item.login?.[name];
			if (typeof value !== "string" || !value || value.length > 16000 || value.includes("\0"))
				throw new Error("Credential field unavailable");
			return value;
		};
		const recheck = async () => {
			await this.check(op.principal);
			this.requireUnlocked();
			signal.throwIfAborted();
			if (op.epoch !== this.epoch || op.state !== "running" || op.expires < Date.now())
				throw new Error("Authorization expired");
		};
		if (input.action === "fill") {
			const origins = this.origins(item).filter((origin) => binding.origins.includes(origin));
			const values = Object.fromEntries(
				await Promise.all(
					[...new Set(input.fields)].map(async (name) => [name, await field(name)]),
				),
			);
			await recheck();
			return this.executors.fillBrowser(
				this.settings.cdpEndpoint,
				input.targetId,
				origins,
				values,
				signal,
			);
		}
		if (action?.kind === "http") {
			const value = await field(action.field);
			await recheck();
			return this.executors.executeHttp(
				action,
				"parameters" in input ? input.parameters : {},
				value,
				signal,
			);
		}
		if (action?.kind === "command") {
			const values = Object.fromEntries(
				await Promise.all(
					Object.entries(action.env).map(async ([key, name]) => [key, await field(name)]),
				),
			);
			await recheck();
			return this.executors.executeCommand(
				action,
				"parameters" in input ? input.parameters : {},
				values,
				this.resources,
				signal,
				input.action === "run_command",
			);
		}
		throw new Error("Unsupported operation");
	}
}
