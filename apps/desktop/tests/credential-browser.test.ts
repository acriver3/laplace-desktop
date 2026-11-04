import { afterEach, expect, it, vi } from "vitest";

import { browserArgument, checkBrowser, CredentialBrowser } from "../src/helper/credential-browser";
afterEach(() => vi.unstubAllGlobals());
it("reads explicit debugging arguments without interpreting shell syntax", () => {
	expect(
		browserArgument(
			'Chrome --remote-debugging-port=9223 --user-data-dir="/a profile/with spaces"',
			"remote-debugging-port",
		),
	).toBe("9223");
	expect(
		browserArgument(
			'Chrome --remote-debugging-port 0 --user-data-dir="/a profile/with spaces"',
			"user-data-dir",
		),
	).toBe("/a profile/with spaces");
	expect(
		browserArgument("Chrome --profile-directory=Default", "remote-debugging-port"),
	).toBeUndefined();
});
it("accepts only verified local browser endpoints", async () => {
	const fetcher = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					Browser: "Chrome/152.0",
					webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/synthetic",
				}),
			),
	);
	vi.stubGlobal("fetch", fetcher);
	expect(await checkBrowser("http://127.0.0.1:9223")).toBe(true);
	expect(await checkBrowser("https://external.invalid")).toBe(false);
	expect(fetcher).toHaveBeenCalledTimes(1);
	fetcher.mockImplementation(
		async () =>
			new Response(
				JSON.stringify({
					Browser: "Chrome/152.0",
					webSocketDebuggerUrl: "ws://external.invalid:9223/devtools/browser/synthetic",
				}),
			),
	);
	expect(await checkBrowser("http://127.0.0.1:9223")).toBe(false);
});
it("treats stale endpoints and oversized responses as unavailable", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("offline");
		}),
	);
	const browser = new CredentialBrowser("/unused", "/unused", () => {});
	expect(await browser.health("http://127.0.0.1:9223")).toMatchObject({
		available: false,
		owned: false,
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("x".repeat(20000))),
	);
	expect(await checkBrowser("http://127.0.0.1:9223")).toBe(false);
	await expect(browser.select("not-discovered")).rejects.toMatchObject({ code: "browser" });
	await expect(browser.launch("not-discovered")).rejects.toMatchObject({ code: "browser" });
});
