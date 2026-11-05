import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import { z } from "zod";

import { identityKey, browserCandidate, type BrowserCandidate } from "./browser-approval";
import { browserExtensionId } from "./browser-extension-id";
import {
	BrowserResultTransfer,
	browserChunkSize,
	browserJsonLimit,
	browserTransferLimit,
	describeTransfer,
	transferLimit,
} from "./browser-transfer";

const secret = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) =>
	a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export interface BrowserProvider {
	id: string;
	label: string;
	workspace: string;
	identitySchema: z.ZodType<{ workspace: string; userId: string }>;
	reads: Record<
		string,
		{
			method: string;
			schema: z.ZodType;
			write?: boolean;
			maxInputBytes?: number;
			maxResultBytes?: number;
		}
	>;
}
type Pending = {
	id: string;
	method: string;
	args: unknown;
	inputBytes: Buffer;
	resultLimit: number;
	transfer?: BrowserResultTransfer;
	delivered: boolean;
	write: boolean;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};
async function json(request: IncomingMessage) {
	const parts: Buffer[] = [];
	let size = 0;
	for await (const part of request) {
		const buffer = Buffer.from(part);
		if ((size += buffer.length) > browserJsonLimit) throw new Error("Response too large.");
		parts.push(buffer);
	}
	return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
/** Defense in depth: neither accidental provider credentials nor arbitrary error text leave the relay. */
export function redactBrowserResult(value: unknown, depth = 0): unknown {
	if (depth > 100) throw Error("Browser response nesting exceeds the limit.");
	if (typeof value === "string") return value.replace(/xox[baprscoed]-[^\s"'<>]+/g, "[redacted]");
	if (Array.isArray(value)) return value.map((item) => redactBrowserResult(item, depth + 1));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key, value]) => {
					if (
						(key === "owaToken" || key === "graphToken") &&
						(value === null ||
							z
								.object({
									expiresAt: z.string().datetime(),
									minutesRemaining: z.number().int().optional(),
								})
								.strict()
								.safeParse(value).success)
					)
						return true;
					return !/token|cookie|authorization|password|secret/i.test(key);
				})
				.map(([key, val]) => [key, redactBrowserResult(val, depth + 1)]),
		);
	return value;
}

/** Only the shipped extension origin may pair. No webpage, cookie API, or generic request proxy. */
export class BrowserConnectionRelay {
	private profiles = new Map<string, { profileId: string; profileLabel: string; seen: number }>();
	private candidates = new Map<string, { candidate: BrowserCandidate; seen: number }>();
	private authorized?: { candidate: BrowserCandidate; secret: string };
	private revoked = false;
	private revocationWaiters = new Set<() => void>();
	private acknowledgedRevocation() {
		return new Promise<void>((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				this.revocationWaiters.delete(done);
				resolve();
			};
			const timer = setTimeout(() => {
				this.revocationWaiters.delete(done);
				reject(Error("Desktop has not acknowledged revocation."));
			}, 8000);
			this.revocationWaiters.add(done);
		});
	}
	private hint = "discovering";
	private focusProfile?: string;
	private code = "";
	private codeExpiry = 0;
	private token = "";
	private sessionRevision = "";
	private approvalExpiry = 0;
	private lastSeen = 0;
	private identity?: { workspace: string; userId: string };
	private pending = new Map<string, Pending>();
	private base = "";
	private server = createServer((request, response) => {
		void (async () => {
			const origin = `chrome-extension://${browserExtensionId}`;
			if (request.headers.host !== new URL(this.base).host || request.headers.origin !== origin) {
				response.writeHead(403).end();
				return;
			}
			response.setHeader("Access-Control-Allow-Origin", origin);
			response.setHeader("Vary", "Origin");
			response.setHeader("Cache-Control", "no-store");
			if (request.method === "OPTIONS") {
				response.setHeader("Access-Control-Allow-Methods", "POST");
				response.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
				response.setHeader("Access-Control-Allow-Private-Network", "true");
				response.writeHead(204).end();
				return;
			}
			if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
				response.writeHead(405).end();
				return;
			}
			const body = await json(request);
			let result: unknown;
			if (request.url === "/describe") {
				const parsed = z
					.object({ code: z.string().max(100) })
					.strict()
					.parse(body);
				if (!this.code || Date.now() >= this.codeExpiry || !equal(parsed.code, this.code))
					throw new Error("Pairing denied.");
				result = { provider: this.provider.id, workspace: this.workspace };
			} else if (
				["/review", "/decision", "/pair", "/withdraw-consent"].includes(request.url ?? "")
			) {
				const envelope = z
					.object({ code: z.string().max(100) })
					.passthrough()
					.parse(body);
				if (!this.code || Date.now() >= this.codeExpiry || !equal(envelope.code, this.code))
					throw new Error("Request expired.");
				if (request.url === "/withdraw-consent") {
					this.provider.identitySchema.parse(body.identity);
					this.disconnect();
					this.revoked = true;
					await this.acknowledgedRevocation();
					result = { revoked: true };
				} else if (request.url === "/review") {
					const parsed = z
						.object({
							code: z.string(),
							profileId: z.string().uuid(),
							profileLabel: z.string().min(1).max(80),
							candidates: z.array(browserCandidate).max(16),
							hint: z.enum(["discovering", "sign_in_required", "permission_required"]),
						})
						.strict()
						.parse(body);
					this.profiles.set(parsed.profileId, {
						profileId: parsed.profileId,
						profileLabel: parsed.profileLabel,
						seen: Date.now(),
					});
					for (const [id, item] of this.candidates)
						if (item.candidate.profileId === parsed.profileId) this.candidates.delete(id);
					for (const candidate of parsed.candidates) {
						if (
							candidate.profileId !== parsed.profileId ||
							candidate.identity.workspace !== this.workspace
						)
							throw new Error("Wrong identity.");
						this.provider.identitySchema.parse(candidate.identity);
						if (this.candidates.size < 64)
							this.candidates.set(candidate.id, { candidate, seen: Date.now() });
					}
					this.hint = parsed.hint;
					result = { received: true };
				} else if (request.url === "/decision") {
					const parsed = z
						.object({ code: z.string(), profileId: z.string().uuid() })
						.strict()
						.parse(body);
					const approval =
						this.authorized?.candidate.profileId === parsed.profileId ? this.authorized : undefined;
					result = {
						...(approval
							? {
									candidateId: approval.candidate.id,
									revision: approval.candidate.revision,
									authorization: approval.secret,
								}
							: {}),
						focus: this.focusProfile === parsed.profileId,
					};
					if (this.focusProfile === parsed.profileId) this.focusProfile = undefined;
				} else {
					const parsed = z
						.object({
							code: z.string(),
							candidateId: z.string().uuid(),
							authorization: z.string().max(100),
							identity: this.provider.identitySchema,
						})
						.strict()
						.parse(body);
					const allowed = this.authorized;
					const current = this.review().candidates.find((c) => c.id === parsed.candidateId);
					if (
						!allowed ||
						!current ||
						current.revision !== allowed.candidate.revision ||
						identityKey(current.identity) !== identityKey(allowed.candidate.identity) ||
						allowed.candidate.id !== parsed.candidateId ||
						!equal(allowed.secret, parsed.authorization) ||
						identityKey(allowed.candidate.identity) !== identityKey(parsed.identity)
					)
						throw new Error("Approval required.");
					this.authorized = undefined;
					this.code = "";
					this.identity = parsed.identity;
					this.token = secret();
					this.sessionRevision = randomUUID();
					this.revoked = false;
					this.approvalExpiry = Date.now() + 8 * 60 * 60_000;
					this.lastSeen = Date.now();
					result = { token: this.token, expiresAt: this.approvalExpiry };
				}
			} else {
				if (
					!this.token ||
					Date.now() >= this.approvalExpiry ||
					!equal(request.headers.authorization ?? "", `Bearer ${this.token}`)
				)
					throw new Error("Approval required.");
				this.lastSeen = Date.now();
				if (request.url === "/next") {
					const next = [...this.pending.values()].find((item) => !item.delivered);
					if (next) next.delivered = true;
					result = {
						request: next
							? {
									id: next.id,
									method: next.method,
									...(next.inputBytes.length > browserJsonLimit / 2
										? { argumentsTransfer: describeTransfer(next.inputBytes) }
										: { args: next.args }),
									resultLimit: next.resultLimit,
								}
							: null,
					};
				} else if (request.url === "/arguments-chunk") {
					const { id, index } = z
						.object({ id: z.string().uuid(), index: z.number().int().nonnegative() })
						.strict()
						.parse(body);
					const pending = this.pending.get(id);
					if (
						!pending?.delivered ||
						index >= Math.ceil(pending.inputBytes.length / browserChunkSize)
					)
						throw Error("Unknown browser transfer.");
					result = {
						data: pending.inputBytes
							.subarray(index * browserChunkSize, (index + 1) * browserChunkSize)
							.toString("base64"),
					};
				} else if (request.url === "/result-chunk") {
					const parsed = z
						.object({
							id: z.string().uuid(),
							index: z.number().int().nonnegative(),
							data: z.string().max(browserChunkSize * 2),
							description: z
								.object({
									bytes: z.number().int().positive(),
									sha256: z.string().regex(/^[a-f0-9]{64}$/),
									chunks: z.number().int().positive(),
								})
								.strict()
								.optional(),
						})
						.strict()
						.parse(body);
					const pending = this.pending.get(parsed.id);
					if (!pending?.delivered) throw Error("Unknown browser request.");
					if (!pending.transfer) {
						if (parsed.index !== 0 || !parsed.description)
							throw Error("Missing browser transfer description.");
						const allocated = [...this.pending.values()].reduce(
							(sum, p) => sum + (p.transfer?.description.bytes ?? 0),
							0,
						);
						if (allocated + parsed.description.bytes > browserTransferLimit * 2)
							throw Error("Browser transfers busy.");
						pending.transfer = new BrowserResultTransfer(parsed.description, pending.resultLimit);
					} else if (parsed.description) throw Error("Transfer already started.");
					pending.transfer.append(parsed.index, parsed.data);
					result = { received: true };
				} else if (request.url === "/result") {
					const parsed = z
						.object({
							id: z.string().uuid(),
							ok: z.boolean(),
							result: z.unknown().optional(),
							transfer: z.literal(true).optional(),
						})
						.strict()
						.parse(body);
					const pending = this.pending.get(parsed.id);
					if (!pending?.delivered) throw new Error("Unknown request.");
					let value = parsed.result;
					if (parsed.ok) {
						if (parsed.transfer) {
							if (!pending.transfer || parsed.result !== undefined)
								throw Error("Invalid transfer completion.");
							value = pending.transfer.finish();
						} else if (
							pending.transfer ||
							Buffer.byteLength(JSON.stringify(value) ?? "null") > pending.resultLimit
						)
							throw Error("Response too large.");
					}
					const sanitized = parsed.ok ? redactBrowserResult(value) : undefined;
					clearTimeout(pending.timer);
					this.pending.delete(parsed.id);
					if (parsed.ok) pending.resolve(sanitized);
					else
						pending.reject(
							new Error(
								pending.write
									? "SAVE_UNVERIFIED: the browser action failed. Read the application before retrying; a save may have occurred."
									: "Browser read failed. Check the approved tab and sign-in; no write was attempted.",
							),
						);
					result = { received: true };
				} else if (request.url === "/revoke-consent") {
					this.disconnect();
					this.revoked = true;
					await this.acknowledgedRevocation();
					result = { revoked: true };
				} else if (request.url === "/pause") {
					this.disconnect();
					result = { disconnected: true };
				} else if (request.url === "/disconnect") {
					this.disconnect();
					this.revoked = true;
					result = { disconnected: true };
				} else {
					response.writeHead(404).end();
					return;
				}
			}
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(result));
		})().catch(() => {
			if (!response.headersSent) response.writeHead(400);
			response.end('{"error":"Browser connection request rejected."}');
		});
	});
	get workspace() {
		return this.provider.workspace;
	}
	constructor(private readonly provider: BrowserProvider) {
		this.server.requestTimeout = 10_000;
	}
	async listen() {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => {
				this.server.removeListener("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Browser bridge unavailable.");
		this.base = `http://127.0.0.1:${address.port}`;
	}
	review() {
		return {
			profiles: [...this.profiles.values()]
				.filter((p) => Date.now() - p.seen < 10000)
				.map(({ seen: _seen, ...p }) => p),
			candidates: [...this.candidates.values()]
				.filter((x) => Date.now() - x.seen < 10000)
				.map((x) => x.candidate),
			hint: this.hint,
		};
	}
	authorize(input: unknown) {
		const args = z
			.object({ candidateId: z.string().uuid(), revision: z.string().uuid() })
			.strict()
			.parse(input);
		const candidate = this.review().candidates.find(
			(x) => x.id === args.candidateId && x.revision === args.revision,
		);
		if (!candidate || !this.code || Date.now() >= this.codeExpiry)
			throw new Error("Review expired.");
		if (
			this.authorized?.candidate.id !== candidate.id ||
			this.authorized?.candidate.revision !== candidate.revision
		)
			this.authorized = { candidate, secret: secret() };
		return { authorized: true };
	}
	focus(input: unknown) {
		const { profileId } = z.object({ profileId: z.string().uuid() }).strict().parse(input);
		this.focusProfile = profileId;
		return { requested: true };
	}
	revoke() {
		for (const done of [...this.revocationWaiters]) done();
		this.disconnect();
		this.revoked = true;
		return { disconnected: true };
	}
	pairing() {
		this.disconnect();
		this.revoked = false;
		this.profiles.clear();
		this.candidates.clear();
		this.authorized = undefined;
		this.hint = "discovering";
		this.code = secret();
		this.codeExpiry = Date.now() + 10 * 60_000;
		return {
			pairingUrl: `${this.base}/#${this.code}`,
			workspace: this.workspace,
			expiresAt: new Date(this.codeExpiry).toISOString(),
		};
	}
	connectionRevision() {
		return this.status().connected ? this.sessionRevision : undefined;
	}
	status() {
		return {
			connected:
				!!this.token && Date.now() < this.approvalExpiry && Date.now() - this.lastSeen < 45_000,
			workspace: this.workspace,
			revoked: this.revoked,
			...(this.identity ? { userId: this.identity.userId } : {}),
		};
	}
	async read(name: string, input: unknown, signal?: AbortSignal) {
		if (!Object.hasOwn(this.provider.reads, name))
			throw new Error(
				Object.values(this.provider.reads).some((action) => action.write)
					? "Only registered browser tools are supported."
					: "Only registered read-only browser tools are supported.",
			);
		const definition = this.provider.reads[name]!;
		const args = definition.schema.parse(input);
		const inputBytes = Buffer.from(JSON.stringify(args));
		if (inputBytes.length > transferLimit(definition.maxInputBytes))
			throw Error("Browser arguments exceed this operation's transfer limit.");
		const resultLimit = transferLimit(definition.maxResultBytes);
		const allocated = [...this.pending.values()].reduce((sum, p) => sum + p.inputBytes.length, 0);
		if (allocated + inputBytes.length > browserTransferLimit * 2)
			throw Error("Browser transfers busy.");
		if (!this.status().connected)
			throw new Error(
				"Approve the Laplace extension in your existing provider tab using Authenticate. No dedicated browser is started.",
			);
		if (this.pending.size >= 16 || signal?.aborted)
			throw new Error("Browser request cancelled or busy.");
		return new Promise<unknown>((resolve, reject) => {
			const id = randomUUID();
			const cancel = () => {
				const pending = this.pending.get(id);
				if (pending) {
					clearTimeout(pending.timer);
					this.pending.delete(id);
					reject(
						new Error(
							pending.write && pending.delivered
								? "SAVE_UNVERIFIED: the browser action timed out or was cancelled. Read before retrying; a save may have occurred."
								: "Browser read cancelled or timed out.",
						),
					);
				}
			};
			const finish = (callback: (value: any) => void) => (value: any) => {
				signal?.removeEventListener("abort", cancel);
				callback(value);
			};
			this.pending.set(id, {
				id,
				method: definition.method,
				args,
				inputBytes,
				resultLimit,
				delivered: false,
				write: definition.write === true,
				resolve: finish(resolve),
				reject: finish(reject),
				timer: setTimeout(() => {
					signal?.removeEventListener("abort", cancel);
					cancel();
				}, 35_000),
			});
			signal?.addEventListener("abort", cancel, { once: true });
		});
	}
	disconnect() {
		this.code = "";
		this.focusProfile = undefined;
		this.authorized = undefined;
		this.token = "";
		this.identity = undefined;
		this.lastSeen = 0;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(
				new Error(
					pending.write && pending.delivered
						? "SAVE_UNVERIFIED: browser approval ended. Read before retrying; a save may have occurred."
						: "Browser approval ended.",
				),
			);
		}
		this.pending.clear();
	}
	async close() {
		this.disconnect();
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}
