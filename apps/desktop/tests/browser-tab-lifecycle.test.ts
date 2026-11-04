import { randomUUID, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

import { expect, it, vi } from "vitest";

// Run the shipped worker, including its tab-close handler, with browser I/O isolated.
// @ts-expect-error The extension is plain JavaScript.
import { provider } from "../browser-extension/providers.js";

async function fixture(providerId: string, workspace: string, tabUrl: string) {
	const session: Record<string, any> = {};
	const local: Record<string, any> = { profileId: randomUUID() };
	const storage = (data: Record<string, any>) => ({
		get: async (key: string | null) => (key ? { [key]: data[key] } : { ...data }),
		set: async (value: object) => Object.assign(data, value),
		remove: async (key: string) => {
			delete data[key];
		},
	});
	const event = () => ({ addListener: vi.fn() });
	let tabs: Array<{ id: number; windowId: number; url: string }> = [];
	let focus = false;
	let authorized = false;
	let candidate: any;
	const chrome = {
		storage: { session: storage(session), local: storage(local) },
		permissions: { contains: vi.fn(async () => true) },
		action: { setBadgeText: vi.fn() },
		tabs: {
			query: async () => tabs,
			create: vi.fn(async ({ url }) => {
				const tab = { id: 42, windowId: 1, url };
				tabs.push(tab);
				return tab;
			}),
			update: vi.fn(async (id) => tabs.find((t) => t.id === id)),
			onRemoved: event(),
			onUpdated: event(),
		},
		windows: { update: vi.fn() },
		scripting: {
			executeScript: async () => [
				{
					frameId: 0,
					result: {
						ok: true,
						result: { workspace, userId: "fixture" },
					},
				},
			],
		},
		runtime: {
			connectNative: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }),
			onMessage: event(),
			onStartup: event(),
			onInstalled: event(),
		},
		alarms: { create() {}, onAlarm: event() },
	};
	const fetch = vi.fn(async (url: string, options: { body: string }) => {
		const body = JSON.parse(options.body);
		let result = {};
		switch (new URL(url).pathname) {
			case "/describe":
				result = { provider: providerId, workspace };
				break;
			case "/review":
				candidate = body.candidates[0];
				break;
			case "/decision":
				result = {
					focus,
					...(authorized && candidate
						? {
								authorization: "fixture",
								candidateId: candidate.id,
								revision: candidate.revision,
							}
						: {}),
				};
				focus = false;
				break;
			case "/pair":
				result = { token: "fixture", expiresAt: Date.now() + 60_000 };
				break;
		}
		return { ok: true, json: async () => result };
	});
	const context = createContext({
		chrome,
		provider,
		fetch,
		URL,
		AbortSignal,
		crypto: webcrypto,
		navigator: { userAgent: "Chrome" },
		setInterval() {},
		setTimeout() {},
		clearTimeout() {},
	});
	const source = await readFile(new URL("../browser-extension/worker.js", import.meta.url), "utf8");
	runInContext(source.replace('import { provider } from "./providers.js";', ""), context);
	const id = randomUUID();
	const discover = async () => {
		context.ticket = {
			id,
			provider: providerId,
			workspace,
			pairingUrl: "http://127.0.0.1:12345/#" + randomUUID().replaceAll("-", "").padEnd(43, "a"),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		await runInContext("accept([ticket])", context);
	};
	const refresh = () => runInContext("refresh()", context);
	const close = async () => {
		tabs = [];
		await chrome.tabs.onRemoved.addListener.mock.calls[0]![0](42);
	};
	return {
		chrome,
		session,
		fetch,
		discover,
		refresh,
		close,
		focus: () => {
			focus = true;
		},
		authorize: () => {
			authorized = true;
		},
		open: () => {
			tabs = [{ id: 42, windowId: 1, url: tabUrl }];
		},
	};
}

it.each([
	["ycombinator", "https://apply.ycombinator.com", "https://apply.ycombinator.com"],
	["slack", "https://fixture.slack.com", "https://fixture.slack.com/client/T123456"],
])("%s leaves closed tabs closed across retries and reconnects", async (id, workspace, tabUrl) => {
	const f = await fixture(id, workspace, tabUrl);
	await f.discover();
	await f.refresh();
	await f.discover(); // Replacement pairing ticket, as after renewal or Desktop restart.
	expect(f.chrome.tabs.create).not.toHaveBeenCalled();
	f.focus();
	await f.refresh();
	expect(f.chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: workspace, active: true });
	await f.close();
	await f.discover();
	await f.refresh();
	expect(f.chrome.tabs.create).toHaveBeenCalledTimes(1);

	// The user reopens the tab; remembered consent may reconnect it without navigation.
	f.open();
	f.authorize();
	await f.refresh();
	expect(Object.keys(f.session)).toHaveLength(1);
	await f.close();
	expect(Object.keys(f.session)).toHaveLength(0);
	expect(f.fetch.mock.calls.some(([url]) => url.endsWith("/pause"))).toBe(true);
	await f.discover();
	await f.refresh();
	expect(f.chrome.tabs.create).toHaveBeenCalledTimes(1);

	f.open();
	f.focus();
	await f.refresh();
	expect(f.chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
	expect(f.chrome.tabs.create).toHaveBeenCalledTimes(1);
});
