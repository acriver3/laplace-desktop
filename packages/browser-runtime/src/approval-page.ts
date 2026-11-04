import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import type { BrowserApprovals } from "./browser-approvals";

const escape = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
	);
const equal = (a: string, b: string) =>
	a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function readForm(request: IncomingMessage) {
	let body = "";
	for await (const chunk of request) {
		body += chunk.toString();
		if (Buffer.byteLength(body) > 4096) throw Error("Form too large");
	}
	return new URLSearchParams(body);
}
/** Request-scoped local UI for hosts without MCP Apps. Approval tokens stay in the UI. */
export async function openBrowserApprovalPage(
	approvals: BrowserApprovals,
	requestId: string,
	clientId: string,
) {
	const route = "/" + randomBytes(32).toString("base64url");
	const csrf = randomBytes(32).toString("base64url");
	let origin = "";
	const server = createServer((req, res) => {
		void (async () => {
			if (req.headers.host !== new URL(origin).host || req.url !== route) {
				res.writeHead(404).end();
				return;
			}
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("Referrer-Policy", "no-referrer");
			res.setHeader("X-Content-Type-Options", "nosniff");
			res.setHeader(
				"Content-Security-Policy",
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
			);
			if (req.method === "POST") {
				if (
					req.headers.origin !== origin ||
					req.headers["content-type"]?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded"
				)
					throw Error("Invalid origin");
				const form = await readForm(req);
				if (!equal(form.get("csrf") ?? "", csrf)) throw Error("Invalid request");
				const action = form.get("action");
				if (action === "approve")
					await approvals.approve(requestId, clientId, form.get("capability") ?? "");
				else if (action === "disconnect") await approvals.cancel(requestId, clientId);
				else if (action === "focus")
					await approvals.focus(requestId, clientId, form.get("profileId") ?? "");
				else throw Error("Unknown action");
				res.writeHead(303, { Location: route }).end();
				return;
			}
			if (req.method !== "GET") {
				res.writeHead(405).end();
				return;
			}
			const { view, capabilities } = approvals.review(requestId, clientId);
			const hidden = (name: string, value: string) =>
				`<input type="hidden" name="${name}" value="${escape(value)}">`;
			const form = (action: string, fields: string, label: string) =>
				`<form method="post" action="${route}">${hidden("csrf", csrf)}${hidden("action", action)}${fields}<button>${escape(label)}</button></form>`;
			const candidates = view.candidates
				.map(
					(c) =>
						`<li><p>${escape(c.profileLabel)} — ${escape(c.identity.userId)} — ${escape(c.identity.workspace)}</p>${capabilities[c.id] ? form("approve", hidden("capability", capabilities[c.id]!), "Approve this account") : ""}</li>`,
				)
				.join("");
			const focus = (view.profiles ?? [])
				.map((p) =>
					form("focus", hidden("profileId", p.profileId), `Finish signing in · ${p.profileLabel}`),
				)
				.join("");
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(
				`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Laplace browser approval</title><style>body{font:16px system-ui;max-width:45rem;margin:3rem auto;padding:1rem}button{padding:.6rem;margin:.5rem 0}li{margin:1rem 0}</style><main><h1>Connect ${escape(view.provider)}</h1><p>${escape(view.workspace)}</p><p>${escape(view.message)}</p><ul>${view.scopes.map((s) => `<li>${escape(s)}</li>`).join("")}</ul><ul>${candidates}</ul>${focus}${form("disconnect", "", "Cancel or disconnect")}<p><a href="${route}">Refresh connection status</a></p></main></html>`,
			);
		})().catch(() => {
			if (!res.headersSent) res.writeHead(400);
			res.end("Request expired or account changed. Refresh and review again.");
		});
	});
	server.requestTimeout = 10000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw Error("Approval page unavailable");
	origin = `http://127.0.0.1:${address.port}`;
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		clearTimeout(expiry);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	const expiry = setTimeout(() => void close(), 10 * 60 * 1000);
	expiry.unref();
	return { url: origin + route, close };
}
