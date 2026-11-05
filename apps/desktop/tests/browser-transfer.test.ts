import { createHash, randomUUID, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

import { BrowserConnectionRelay } from "@repo/browser-runtime/browser-connection-relay";
import { browserExtensionId } from "@repo/browser-runtime/browser-extension-id";
import {
	browserChunkSize,
	BrowserResultTransfer,
	describeTransfer,
} from "@repo/browser-runtime/browser-transfer";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { approveBrowser } from "./fixtures/browser-approval";

const relays: BrowserConnectionRelay[] = [];
afterEach(async () => {
	await Promise.all(relays.splice(0).map((r) => r.close()));
});
async function setup() {
	const identity = { workspace: "https://fixture.example", userId: "fixture" };
	const relay = new BrowserConnectionRelay({
		id: "fixture",
		label: "Fixture",
		workspace: identity.workspace,
		identitySchema: z.object({ workspace: z.string(), userId: z.string() }),
		reads: {
			attachment: {
				method: "attachment",
				schema: z.object({ bytes: z.string() }),
				maxInputBytes: 4 * 1024 * 1024,
				maxResultBytes: 4 * 1024 * 1024,
				write: true,
			},
		},
	});
	relays.push(relay);
	await relay.listen();
	const url = new URL(relay.pairing().pairingUrl);
	let token = "";
	const post = (path: string, body: unknown) =>
		fetch(url.origin + path, {
			method: "POST",
			headers: {
				Origin: `chrome-extension://${browserExtensionId}`,
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		});
	token = (await (await approveBrowser(relay, post, url.hash.slice(1), identity)).json()).token;
	return { relay, post };
}
it("transfers a large attachment in both directions and validates its invocation-bound checksum", async () => {
	const { relay, post } = await setup();
	const args = { bytes: "a".repeat(2 * 1024 * 1024) };
	const result = relay.read("attachment", args);
	const { request } = await (await post("/next", {})).json();
	expect(request.args).toBeUndefined();
	const received = [];
	for (let index = 0; index < request.argumentsTransfer.chunks; index++) {
		const chunk = await (await post("/arguments-chunk", { id: request.id, index })).json();
		received.push(Buffer.from(chunk.data, "base64"));
	}
	const input = Buffer.concat(received);
	expect(createHash("sha256").update(input).digest("hex")).toBe(request.argumentsTransfer.sha256);
	expect(JSON.parse(input.toString())).toEqual(args);
	const output = Buffer.from(JSON.stringify({ attachment: args.bytes, token: "must-be-redacted" }));
	const description = describeTransfer(output);
	for (let index = 0; index < description.chunks; index++) {
		const response = await post("/result-chunk", {
			id: request.id,
			index,
			data: output
				.subarray(index * browserChunkSize, (index + 1) * browserChunkSize)
				.toString("base64"),
			...(index === 0 ? { description } : {}),
		});
		expect(response.status).toBe(200);
	}
	expect((await post("/result", { id: request.id, ok: true, transfer: true })).status).toBe(200);
	expect(await result).toEqual({ attachment: args.bytes });
	expect((await post("/arguments-chunk", { id: request.id, index: 0 })).status).toBe(400);
});
it("rejects foreign IDs, oversize or reordered transfers and does not replay an interrupted write", async () => {
	const { relay, post } = await setup();
	const controller = new AbortController();
	const outcome = relay
		.read("attachment", { bytes: "small" }, controller.signal)
		.catch((error) => error.message);
	const { request } = await (await post("/next", {})).json();
	const description = describeTransfer(Buffer.from('"ok"'));
	const body = {
		id: request.id,
		index: 0,
		data: Buffer.from('"ok"').toString("base64"),
		description,
	};
	expect((await post("/result-chunk", { ...body, id: randomUUID() })).status).toBe(400);
	expect((await post("/result-chunk", { ...body, index: 1 })).status).toBe(400);
	expect(
		(
			await post("/result-chunk", {
				...body,
				description: { ...description, bytes: 32 * 1024 * 1024 + 1 },
			})
		).status,
	).toBe(400);
	expect((await post("/result-chunk", body)).status).toBe(200);
	controller.abort();
	expect(await outcome).toContain("SAVE_UNVERIFIED");
	expect((await (await post("/next", {})).json()).request).toBeNull();
	expect((await post("/result", { id: request.id, ok: true, transfer: true })).status).toBe(400);
});
it("rejects corrupted and incomplete attachment bytes", () => {
	const bytes = Buffer.from('"attachment"');
	const transfer = new BrowserResultTransfer(
		{ ...describeTransfer(bytes), sha256: "0".repeat(64) },
		1024,
	);
	expect(() => transfer.finish()).toThrow("Incomplete");
	transfer.append(0, bytes.toString("base64"));
	expect(() => transfer.finish()).toThrow("checksum");
	expect(() => transfer.append(0, bytes.toString("base64"))).toThrow("chunk");
});
it("the shipped worker sends chunks to new relays while preserving legacy JSON interoperability", async () => {
	const source = await readFile(
		new URL("../../../packages/browser-runtime/extension/worker.js", import.meta.url),
		"utf8",
	);
	const calls: Array<{ path: string; body: any }> = [];
	const event = { addListener() {} };
	const context = createContext({
		provider() {},
		URL,
		AbortSignal,
		TextEncoder,
		TextDecoder,
		Uint8Array,
		btoa,
		atob,
		crypto: webcrypto,
		setInterval() {},
		setTimeout,
		clearTimeout,
		navigator: { userAgent: "fixture" },
		fetch: vi.fn(async (url: string, options: { body: string }) => {
			calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
			return { ok: true, json: async () => ({}) };
		}),
		chrome: {
			runtime: {
				connectNative: () => ({ onMessage: event, onDisconnect: event, postMessage() {} }),
				onMessage: event,
				onStartup: event,
				onInstalled: event,
			},
			alarms: { create() {}, onAlarm: event },
			tabs: { onRemoved: event, onUpdated: event },
			storage: { session: { get: async () => ({}) } },
			action: { setBadgeText: async () => {} },
		},
	});
	runInContext(source.replace(/^import .*;$/gm, ""), context);
	const value = { ok: true, result: { attachment: "a".repeat(1024 * 1024) } };
	await context.sendResult(
		{ base: "http://127.0.0.1:1", token: "fixture" },
		{ id: randomUUID(), resultLimit: 2 * 1024 * 1024 },
		value,
	);
	expect(calls.filter((c) => c.path === "/result-chunk").length).toBeGreaterThan(1);
	expect(calls.at(-1)?.body.transfer).toBe(true);
	calls.length = 0;
	await context.sendResult(
		{ base: "http://127.0.0.1:1", token: "fixture" },
		{ id: randomUUID() },
		{ ok: true, result: "legacy" },
	);
	expect(calls).toMatchObject([{ path: "/result", body: { ok: true, result: "legacy" } }]);
});
