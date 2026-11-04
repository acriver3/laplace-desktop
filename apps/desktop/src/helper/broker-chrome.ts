import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { browserExtensionId } from "../shared/browser-extension-id";
import type { LoginObservation } from "./broker-browser";

const origin = z
	.string()
	.url()
	.refine((s) => new URL(s).origin === s && s.startsWith("https://"));
const observation = z
	.object({
		origin,
		revision: z.string().regex(/^[a-f0-9]{64}$/),
		fields: z.array(z.enum(["username", "password"])).max(2),
		handles: z.array(z.string().uuid()).max(2),
		handoff: z.boolean(),
		handoffReason: z
			.enum([
				"unsupported_frame_or_challenge",
				"ambiguous_or_unsupported_form",
				"no_login_fields",
				"ambiguous_submit",
				"permission_required",
			])
			.optional(),
	})
	.strict();
const equal = (a: string, b: string) =>
	Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
type Pending = {
	id: string;
	method: string;
	input: unknown;
	delivered: boolean;
	resolve: (v: any) => void;
	reject: () => void;
};
type Session = {
	code: string;
	token?: string;
	url: string;
	origins: string[];
	expires: number;
	pending?: Pending;
};

/** Direct, ephemeral extension transport. No commands, values, or responses are persisted. */
export class BrokerChrome {
	private sessions = new Map<string, Session>();
	private base = "";
	private starting?: Promise<void>;
	private server = createServer((req, res) => {
		void (async () => {
			const extensionOrigin = `chrome-extension://${browserExtensionId}`;
			if (
				!this.base ||
				req.headers.host !== new URL(this.base).host ||
				req.headers.origin !== extensionOrigin
			) {
				res.writeHead(403).end();
				return;
			}
			res.setHeader("Access-Control-Allow-Origin", extensionOrigin);
			res.setHeader("Cache-Control", "no-store");
			if (req.method === "OPTIONS") {
				res
					.writeHead(204, {
						"Access-Control-Allow-Methods": "POST",
						"Access-Control-Allow-Headers": "authorization,content-type",
						"Access-Control-Allow-Private-Network": "true",
					})
					.end();
				return;
			}
			if (req.method !== "POST" || req.headers["content-type"] !== "application/json")
				throw Error();
			let text = "";
			for await (const b of req) {
				text += b.toString();
				if (Buffer.byteLength(text) > 32000) throw Error();
			}
			const body = JSON.parse(text);
			const id = z.string().uuid().parse(body.id),
				s = this.sessions.get(id);
			if (!s || Date.now() >= s.expires) throw Error();
			let result: unknown;
			if (req.url === "/describe" || req.url === "/connect") {
				if (s.token || typeof body.code !== "string" || !equal(body.code, s.code)) throw Error();
				result = { origins: s.origins };
				if (req.url === "/connect") {
					s.token = randomBytes(32).toString("base64url");
					s.code = "";
					result = { token: s.token, url: s.url, expires: s.expires };
					s.url = "";
				}
			} else {
				if (!s.token || !equal(req.headers.authorization ?? "", "Bearer " + s.token)) throw Error();
				if (req.url === "/next") {
					const p = s.pending;
					result = p && !p.delivered ? { id: p.id, method: p.method, input: p.input } : null;
					if (p && !p.delivered) {
						p.delivered = true;
						p.input = undefined;
					}
				} else if (req.url === "/result") {
					const p = s.pending;
					if (!p || !p.delivered || body.requestId !== p.id) throw Error();
					if (body.ok !== true) p.reject();
					else
						p.resolve(
							p.method === "inspect"
								? observation.parse(body.result)
								: z
										.object({ done: z.literal(true) })
										.strict()
										.parse(body.result),
						);
					s.pending = undefined;
					result = { received: true };
				} else throw Error();
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(result));
		})().catch(() => {
			if (!res.headersSent) res.writeHead(403);
			res.end();
		});
	});
	constructor(private launch: (url: string) => Promise<void>) {}
	private async listen() {
		if (!this.starting)
			this.starting = new Promise<void>((resolve, reject) => {
				this.server.once("error", reject);
				this.server.listen(0, "127.0.0.1", () => {
					const address = this.server.address();
					if (!address || typeof address === "string") {
						reject(Error());
						return;
					}
					this.base = `http://127.0.0.1:${address.port}`;
					resolve();
				});
			});
		await this.starting;
	}
	async open(url: string, origins: string[], signal: AbortSignal) {
		const destination = new URL(url);
		if (destination.protocol !== "https:" || destination.username || destination.password)
			throw Error("Unsupported sign-in URL.");
		await this.listen();
		signal.throwIfAborted();
		const id = randomUUID(),
			code = randomBytes(32).toString("base64url");
		this.sessions.set(id, {
			code,
			url,
			origins: z.array(origin).min(1).max(20).parse(origins),
			expires: Date.now() + 15 * 60000,
		});
		try {
			await this.launch(
				`chrome-extension://${browserExtensionId}/broker.html#${encodeURIComponent(JSON.stringify({ base: this.base, id, code }))}`,
			);
		} catch {
			this.cancel(id);
			throw Error("Open Chrome with the Laplace extension installed.");
		}
		if (signal.aborted) {
			this.cancel(id);
			signal.throwIfAborted();
		}
		return id;
	}
	private async call(
		id: string,
		method: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<any> {
		const s = this.sessions.get(id);
		if (!s?.token || Date.now() >= s.expires || s.pending)
			throw Error("Finish the Laplace extension handoff in Chrome.");
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const fail = () => finish(false);
			const timer = setTimeout(fail, 15000);
			const finish = (ok: boolean, value?: unknown) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", fail);
				s.pending = undefined;
				if (ok) resolve(value);
				else {
					if (method === "advance") this.sessions.delete(id);
					reject(Error("Browser step unavailable or uncertain. It was not replayed."));
				}
			};
			s.pending = {
				id: randomUUID(),
				method,
				input,
				delivered: false,
				resolve: (v) => finish(true, v),
				reject: fail,
			};
			signal.addEventListener("abort", fail, { once: true });
		});
	}
	async inspect(id: string, signal: AbortSignal): Promise<LoginObservation> {
		const s = this.sessions.get(id);
		signal.throwIfAborted();
		if (s && Date.now() >= s.expires) {
			this.cancel(id);
			throw Error("Browser review expired.");
		}
		if (s && !s.token)
			return {
				origin: s.origins[0]!,
				revision: createHash("sha256").update(id).digest("hex"),
				fields: [],
				handles: [],
				handoff: true,
				handoffReason: "permission_required",
			};
		return this.call(id, "inspect", {}, signal);
	}
	async advance(id: string, revision: string, values: Record<string, string>, signal: AbortSignal) {
		const s = this.sessions.get(id),
			before = await this.inspect(id, signal);
		if (!s || before.handoff || before.revision !== revision || !s.origins.includes(before.origin))
			throw Error("Login changed or requires user action.");
		await this.call(
			id,
			"advance",
			{
				revision,
				origin: before.origin,
				expires: Math.min(s.expires, Date.now() + 15000),
				values: Object.fromEntries(before.fields.map((f) => [f, values[f]])),
			},
			signal,
		);
		return { submitted: true };
	}
	async focus(id: string, signal: AbortSignal) {
		await this.call(id, "focus", {}, signal);
	}
	cancel(id: string) {
		this.sessions.get(id)?.pending?.reject();
		this.sessions.delete(id);
	}
	close() {
		for (const id of this.sessions.keys()) this.cancel(id);
	}
	shutdown() {
		this.close();
		this.server.close(() => {});
	}
}
