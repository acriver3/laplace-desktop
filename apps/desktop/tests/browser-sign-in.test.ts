import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { beginBrowserSignIn, type BrowserSignIn } from "../src/main/sign-in";

const origin = "https://connect.fixture.invalid";
const flows: BrowserSignIn[] = [];
type Exchange = Parameters<typeof beginBrowserSignIn>[1];
async function start(exchange: Exchange = async () => {}) {
	const flow = await beginBrowserSignIn(origin, exchange);
	flows.push(flow);
	return flow;
}
function callback(flow: BrowserSignIn) {
	const authorization = new URL(flow.url);
	const url = new URL(authorization.searchParams.get("redirect_uri")!);
	url.searchParams.set("code", "c".repeat(43));
	url.searchParams.set("state", authorization.searchParams.get("state")!);
	url.searchParams.set("iss", origin);
	return url;
}
function get(url: URL, options: { host?: string; method?: string; path?: string } = {}) {
	return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>(
		(resolve, reject) => {
			const request = httpRequest(
				{
					hostname: "127.0.0.1",
					port: url.port,
					method: options.method ?? "GET",
					path: options.path ?? `${url.pathname}${url.search}`,
					headers: { Host: options.host ?? url.host, Connection: "close" },
					agent: false,
				},
				(response) => {
					let body = "";
					response.setEncoding("utf8");
					response.on("data", (chunk: string) => {
						body += chunk;
					});
					response.on("end", () =>
						resolve({ status: response.statusCode!, body, headers: response.headers }),
					);
				},
			);
			request.once("error", reject);
			request.setTimeout(3000, () => request.destroy(new Error("Callback test timed out")));
			request.end();
		},
	);
}
afterEach(async () => {
	await Promise.all(
		flows.splice(0).map(async (flow) => {
			flow.cancel();
			await flow.completed.catch(() => {});
		}),
	);
});

describe("browser sign-in loopback listener", () => {
	it("uses random PKCE and an ephemeral IPv4 loopback callback; only exchange receives the verifier", async () => {
		const exchange = vi.fn<Exchange>().mockResolvedValue(undefined);
		const flow = await start(exchange);
		const authorization = new URL(flow.url);
		const url = callback(flow);
		expect(authorization.origin).toBe(origin);
		expect(authorization.pathname).toBe("/desktop/sign-in");
		expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.hostname).toBe("127.0.0.1");
		expect(Number(url.port)).toBeGreaterThan(0);
		const response = await get(url);
		await flow.completed;
		expect(response.status).toBe(200);
		expect(exchange).toHaveBeenCalledOnce();
		const body = exchange.mock.calls[0]![0];
		expect(body.redirect_uri).toBe(authorization.searchParams.get("redirect_uri"));
		expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(
			authorization.searchParams.get("code_challenge"),
		);
		expect(flow.url).not.toContain(body.code_verifier);
		for (const secret of [body.code, body.state, body.code_verifier])
			expect(response.body).not.toContain(secret);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.headers["referrer-policy"]).toBe("no-referrer");
	});
	it.each(["host", "state", "unicode-state", "issuer", "code", "path", "method", "length"])(
		"rejects invalid %s and leaves the valid flow usable",
		async (kind) => {
			const exchange = vi.fn<Exchange>().mockResolvedValue(undefined);
			const flow = await start(exchange);
			const url = callback(flow);
			const options: Parameters<typeof get>[1] = {};
			if (kind === "host") options.host = "attacker.invalid";
			if (kind === "state") url.searchParams.set("state", "s".repeat(43));
			if (kind === "unicode-state") url.searchParams.set("state", "é".repeat(43));
			if (kind === "issuer") url.searchParams.set("iss", "https://attacker.invalid");
			if (kind === "code") url.searchParams.set("code", "invalid");
			if (kind === "path") url.pathname = "/unrelated";
			if (kind === "method") options.method = "POST";
			if (kind === "length") url.searchParams.set("padding", "x".repeat(4097));
			expect((await get(url, options)).status).toBe(400);
			expect(exchange).not.toHaveBeenCalled();
			expect((await get(callback(flow))).status).toBe(200);
			await flow.completed;
		},
	);
	it("rejects a concurrent replay while the first exchange is in flight", async () => {
		let complete!: () => void;
		const exchange = vi.fn<Exchange>(
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		const flow = await start(exchange);
		const url = callback(flow);
		const first = get(url);
		await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
		expect((await get(url)).status).toBe(400);
		complete();
		expect((await first).status).toBe(200);
		await flow.completed;
		expect(exchange).toHaveBeenCalledOnce();
		await expect(get(url)).rejects.toThrow();
	});
	it("cancels and closes the listener without exchanging", async () => {
		const exchange = vi.fn<Exchange>().mockResolvedValue(undefined);
		const flow = await start(exchange);
		flow.cancel();
		await expect(flow.completed).rejects.toThrow("Sign-in cancelled");
		await expect(get(callback(flow))).rejects.toThrow();
		expect(exchange).not.toHaveBeenCalled();
	});
	it("does not echo exchange errors or grant secrets to the browser or UI", async () => {
		const secret = "sensitive-provider-error-with-token";
		const flow = await start(async () => {
			throw new Error(secret);
		});
		const response = await get(callback(flow));
		expect(response.status).toBe(400);
		expect(response.body).not.toContain(secret);
		await expect(flow.completed).rejects.toThrow(
			"The desktop sign-in grant could not be exchanged",
		);
		await flow.completed.catch((error: Error) => expect(error.message).not.toContain(secret));
	});
});
