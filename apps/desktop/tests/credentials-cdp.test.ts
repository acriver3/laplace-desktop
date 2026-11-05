import { runInNewContext } from "node:vm";

import { fillBrowser } from "@repo/local-runtime/credentials-cdp";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
function browser(origin = "https://example.com", formOrigin = origin, count = 1) {
	class Input {
		disabled = false;
		readOnly = false;
		stored = "";
		form = { action: `${formOrigin}/login` };
		get value() {
			return this.stored;
		}
		set value(v: string) {
			this.stored = v;
		}
		getClientRects() {
			return [{}];
		}
		dispatchEvent() {
			return true;
		}
	}
	const fields = Array.from({ length: count }, () => new Input());
	const calls: Array<{ method: string; params: any }> = [];
	class Socket extends EventTarget {
		constructor() {
			super();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		send(text: string) {
			const message = JSON.parse(text);
			calls.push(message);
			let result: unknown;
			if (message.method === "Page.getFrameTree")
				result = { frameTree: { frame: { id: "frame" } } };
			if (message.method === "Page.createIsolatedWorld") result = { executionContextId: 7 };
			if (message.method === "Runtime.evaluate") {
				const window: any = {};
				window.top = window;
				const value = runInNewContext(message.params.expression, {
					location: { origin, href: `${origin}/login` },
					window,
					document: { querySelectorAll: () => fields },
					HTMLInputElement: Input,
					URL,
					Event,
				});
				result = { result: { value } };
			}
			queueMicrotask(() =>
				this.dispatchEvent(
					new MessageEvent("message", { data: JSON.stringify({ id: message.id, result }) }),
				),
			);
		}
		close() {
			this.dispatchEvent(new Event("close"));
		}
	}
	vi.stubGlobal("WebSocket", Socket);
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify([
						{
							id: "tab",
							type: "page",
							url: "https://example.com/login",
							webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/tab",
						},
					]),
				),
		),
	);
	return { fields, calls };
}
it("fills through an isolated CDP context and returns only counts and origin", async () => {
	const f = browser();
	const result = await fillBrowser(
		"http://127.0.0.1:9222",
		"tab",
		["https://example.com"],
		{ password: "synthetic-password" },
		new AbortController().signal,
	);
	expect(result).toEqual({ filledFields: 1, origin: "https://example.com" });
	expect(f.fields[0].value).toBe("synthetic-password");
	expect(f.calls.find((c) => c.method === "Runtime.evaluate")?.params.contextId).toBe(7);
	expect(JSON.stringify(result)).not.toContain("synthetic-password");
});
it.each([
	["https://other.example", "https://other.example", 1],
	["https://example.com", "https://other.example", 1],
	["https://example.com", "https://example.com", 2],
])(
	"refuses changed origins, external form actions, and ambiguous fields (%s %s %d)",
	async (origin, form, count) => {
		const f = browser(origin, form, count);
		await expect(
			fillBrowser(
				"http://127.0.0.1:9222",
				"tab",
				["https://example.com"],
				{ password: "synthetic-password" },
				new AbortController().signal,
			),
		).rejects.toThrow();
		expect(f.fields.every((field) => field.value === "")).toBe(true);
	},
);
it("never opens a CDP session for an unapproved target origin", async () => {
	const f = browser();
	await expect(
		fillBrowser(
			"http://127.0.0.1:9222",
			"tab",
			["https://other.example"],
			{ password: "synthetic-password" },
			new AbortController().signal,
		),
	).rejects.toThrow("origin mismatch");
	expect(f.calls).toEqual([]);
});
