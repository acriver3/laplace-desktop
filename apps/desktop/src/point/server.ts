import { createServer, type Server } from "node:http";

import { z } from "zod";

import { PointCaptures, type StoredCapture } from "./captures";
import { pageScript, pageStyle, snipPage } from "./page";

const pageState = z.enum(["ready", "unsupported", "failed", "requested", "declined"]);
export type SnipPageState = z.infer<typeof pageState>;
export class PointServer {
	private server?: Server;
	private states = new Map<string, SnipPageState>();
	origin = "";
	constructor(private readonly captures: PointCaptures) {}
	url(item: StoredCapture) {
		return `${this.origin}/capture/${item.token}/`;
	}
	state(item: StoredCapture) {
		return this.states.get(item.id);
	}
	reset(item: StoredCapture) {
		this.states.delete(item.id);
	}
	async start() {
		const server = createServer(async (req, res) => {
			const headers = {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
				"Content-Security-Policy":
					"default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
			};
			for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
			const fail = (code = 404) => {
				res.writeHead(code);
				res.end();
			};
			if (
				req.headers.host !== new URL(this.origin).host ||
				(req.headers.origin && req.headers.origin !== this.origin)
			)
				return fail(403);
			const match = /^\/capture\/([a-f0-9]{64})\/(|image\.png|page\.js|style\.css|status)$/.exec(
				req.url ?? "",
			);
			const item = match && this.captures.byToken(match[1]!);
			if (!item || !match) return fail();
			try {
				if (req.method === "POST" && match[2] === "status") {
					if (
						req.headers.origin !== this.origin ||
						req.headers["content-type"] !== "application/json"
					)
						return fail(403);
					const chunks: Buffer[] = [];
					let size = 0;
					for await (const chunk of req) {
						size += chunk.length;
						if (size > 128) {
							fail(413);
							req.destroy();
							return;
						}
						chunks.push(chunk);
					}
					const body = z
						.object({ state: pageState })
						.strict()
						.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					this.states.set(item.id, body.state);
					res.writeHead(204);
					res.end();
					return;
				}
				if (req.method !== "GET") return fail(405);
				if (match[2] === "") {
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end(snipPage(item));
				} else if (match[2] === "page.js") {
					res.setHeader("Content-Type", "text/javascript; charset=utf-8");
					res.end(pageScript);
				} else if (match[2] === "style.css") {
					res.setHeader("Content-Type", "text/css; charset=utf-8");
					res.end(pageStyle);
				} else if (match[2] === "image.png") {
					res.setHeader("Content-Type", "image/png");
					res.end(await this.captures.read(item));
				} else fail();
			} catch {
				if (!res.headersSent) fail(400);
				else res.end();
			}
		});
		server.requestTimeout = 5000;
		server.headersTimeout = 5000;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		this.server = server;
		this.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	}
	async stop() {
		const server = this.server;
		this.server = undefined;
		this.states.clear();
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}
}
