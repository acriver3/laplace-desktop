import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { BrokerChrome } from "../src/helper/broker-chrome";
import { browserExtensionId } from "../src/shared/browser-extension-id";

it("pairs only the shipped extension, delivers once, sanitizes results and cancels pending work", async () => {
	let ticket: any;
	const chrome = new BrokerChrome(async (url) => {
		ticket = JSON.parse(decodeURIComponent(new URL(url).hash.slice(1)));
	});
	const signal = AbortSignal.timeout(10000);
	const id = await chrome.open(
		"https://accounts.google.com/login",
		["https://accounts.google.com"],
		signal,
	);
	let token = "";
	const post = (
		path: string,
		body: object = {},
		origin = `chrome-extension://${browserExtensionId}`,
	) =>
		fetch(ticket.base + path, {
			method: "POST",
			headers: {
				Origin: origin,
				"Content-Type": "application/json",
				Authorization: "Bearer " + token,
			},
			body: JSON.stringify({ id, ...body }),
		});
	try {
		expect((await chrome.inspect(id, signal)).handoffReason).toBe("permission_required");
		expect(
			(await post("/connect", { code: ticket.code }, "https://untrusted.invalid")).status,
		).toBe(403);
		expect((await post("/connect", { code: "wrong" })).status).toBe(403);
		const connected = await (await post("/connect", { code: ticket.code })).json();
		token = connected.token;
		expect(connected.url).toBe("https://accounts.google.com/login");
		expect((await post("/connect", { code: ticket.code })).status).toBe(403);
		const view = {
			origin: "https://accounts.google.com",
			revision: "a".repeat(64),
			fields: ["password"],
			handles: [randomUUID()],
			handoff: false,
		};
		const pending = chrome.inspect(id, signal);
		const command = await (await post("/next")).json();
		expect(command.method).toBe("inspect");
		expect(await (await post("/next")).json()).toBeNull();
		expect(
			(
				await post("/result", {
					requestId: command.id,
					ok: true,
					result: { ...view, value: "synthetic-secret" },
				})
			).status,
		).toBe(403);
		await post("/result", { requestId: command.id, ok: true, result: view });
		expect(await pending).toEqual(view);
		const advance = chrome.advance(
			id,
			view.revision,
			{ username: "unused-canary", password: "synthetic-secret" },
			signal,
		);
		const inspect = await (await post("/next")).json();
		await post("/result", { requestId: inspect.id, ok: true, result: view });
		const fill = await (await post("/next")).json();
		expect(fill.input.values).toEqual({ password: "synthetic-secret" });
		expect(await (await post("/next")).json()).toBeNull();
		await post("/result", { requestId: fill.id, ok: true, result: { done: true } });
		expect(await advance).toEqual({ submitted: true });
		const cancelled = chrome.inspect(id, signal);
		const rejected = expect(cancelled).rejects.toThrow("not replayed");
		chrome.cancel(id);
		await rejected;
		expect((await post("/next")).status).toBe(403);
	} finally {
		chrome.shutdown();
	}
});

it("does not launch for invalid origins or an aborted approval", async () => {
	let launches = 0;
	const chrome = new BrokerChrome(async () => {
		launches++;
	});
	try {
		await expect(
			chrome.open("https://login.invalid", ["http://login.invalid"], new AbortController().signal),
		).rejects.toThrow();
		await expect(
			chrome.open("https://login.invalid", ["https://login.invalid"], AbortSignal.abort()),
		).rejects.toThrow();
		expect(launches).toBe(0);
	} finally {
		chrome.shutdown();
	}
});
