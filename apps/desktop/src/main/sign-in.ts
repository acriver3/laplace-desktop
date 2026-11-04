import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const random = () => randomBytes(32).toString("base64url");
const same = (a: string, b: string) => {
	const left = Buffer.from(a),
		right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};

export interface BrowserSignIn {
	url: string;
	cancel(): void;
	completed: Promise<void>;
}

/** The callback listener accepts only a bounded, state-bound loopback GET. */
export async function beginBrowserSignIn(
	origin: string,
	exchange: (body: {
		code: string;
		state: string;
		code_verifier: string;
		redirect_uri: string;
	}) => Promise<void>,
): Promise<BrowserSignIn> {
	const state = random();
	const verifier = random();
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	let settled = false;
	let exchanging = false;
	let callback = "";
	let server: Server;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const completed = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	// A caller installs its own completion handler after opening the browser.
	void completed.catch(() => {});
	const finish = (error?: Error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		server.close();
		if (error) reject(error);
		else resolve();
	};
	server = createServer(async (request, response) => {
		response.setHeader("Content-Type", "text/plain; charset=utf-8");
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
		const expected = new URL(callback);
		if (
			request.method !== "GET" ||
			request.headers.host !== expected.host ||
			(request.url?.length ?? 0) > 4096
		) {
			response.writeHead(400).end("Invalid desktop callback.");
			return;
		}
		const url = new URL(request.url ?? "/", callback);
		const code = url.searchParams.get("code") ?? "";
		if (
			url.pathname !== expected.pathname ||
			!same(url.searchParams.get("state") ?? "", state) ||
			url.searchParams.get("iss") !== origin ||
			!/^[A-Za-z0-9_-]{43}$/.test(code) ||
			exchanging ||
			settled
		) {
			response
				.writeHead(400)
				.end(
					"This sign-in response does not match Laplace Desktop. Return to the app and try again.",
				);
			return;
		}
		exchanging = true;
		try {
			await exchange({ code, state, code_verifier: verifier, redirect_uri: callback });
			response.end("Signed in. You can return to Laplace Desktop and close this tab.");
			finish();
		} catch {
			response
				.writeHead(400)
				.end("Sign-in could not be completed. Return to Laplace Desktop and try again.");
			finish(new Error("The desktop sign-in grant could not be exchanged. Please try again."));
		}
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	await new Promise<void>((yes, no) => {
		server.once("error", no);
		server.listen(0, "127.0.0.1", yes);
	});
	callback = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback/laplace-desktop`;
	timeout = setTimeout(() => finish(new Error("Sign-in timed out. Please try again.")), 5 * 60_000);
	timeout.unref();
	const url = new URL("/desktop/sign-in", origin);
	url.search = new URLSearchParams({
		redirect_uri: callback,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	}).toString();
	return { url: url.href, completed, cancel: () => finish(new Error("Sign-in cancelled.")) };
}
