import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { expect, it, vi } from "vitest";

const source = (
	await readFile(
		new URL("../../../packages/browser-runtime/extension/slack.js", import.meta.url),
		"utf8",
	)
).replace("export async function", "async function");
const workspace = "https://fixture.slack.com";
const originalIdentity = { workspace, teamId: "T123456", userId: "U123456" };
function fixture(
	options: {
		context?: string;
		teams?: Record<string, unknown>;
		identity?: Record<string, unknown>;
		response?: Record<string, unknown>;
	} = {},
) {
	const context = options.context || "T123456";
	const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
		return new Response(
			JSON.stringify(
				_url.endsWith("/auth.test")
					? options.response || {
							ok: true,
							team_id: "T123456",
							user_id: "U123456",
							url: workspace + "/",
							...options.identity,
						}
					: { ok: true, channels: [{ id: "C123456", name: "fixture" }] },
			),
		);
	});
	const read = runInNewContext(source + "\nslackRead", {
		location: new URL("https://app.slack.com/client/" + context + "/C123456"),
		localStorage: {
			getItem: () =>
				JSON.stringify({ teams: options.teams || { [context]: { token: "xoxc-synthetic" } } }),
		},
		fetch,
		URL,
		URLSearchParams,
		AbortSignal,
		Uint8Array,
		TextDecoder,
	}) as (
		method: string,
		args: object,
		expected: object | null,
		workspace: string,
	) => Promise<{ ok: boolean; result?: typeof originalIdentity; error?: string }>;
	return { read, fetch };
}
it("keeps normal workspace tabs working and returns only the verified identity", async () => {
	const { read } = fixture();
	expect(await read("auth.test", {}, null, workspace)).toEqual({
		ok: true,
		result: originalIdentity,
	});
});
it("recognizes an Enterprise tab without treating its organization ID as a workspace ID", async () => {
	const { read, fetch } = fixture({ context: "E123456", identity: { enterprise_id: "E123456" } });
	expect(await read("auth.test", {}, null, workspace)).toEqual({
		ok: true,
		result: originalIdentity,
	});
	expect(await read("conversations.list", { limit: 1 }, originalIdentity, workspace)).toMatchObject(
		{ ok: true },
	);
	const last = fetch.mock.calls.at(-1)!;
	expect((last[1].body as URLSearchParams).get("team_id")).toBe("T123456");
});
it("recognizes a verified organization context while preserving its canonical workspace", async () => {
	const { read } = fixture({ context: "E123456", identity: { team_id: "E123456" } });
	expect(await read("auth.test", {}, null, workspace)).toEqual({
		ok: true,
		result: { ...originalIdentity, teamId: "E123456" },
	});
});
it("selects only the explicitly requested workspace within an Enterprise tab", async () => {
	const { read, fetch } = fixture({
		context: "E123456",
		identity: { enterprise_id: "E123456" },
		teams: {
			T654321: { domain: "unrelated", token: "xoxc-unrelated" },
			T123456: { domain: "fixture", token: "xoxc-selected" },
		},
	});
	expect((await read("auth.test", {}, null, workspace)).ok).toBe(true);
	expect((fetch.mock.calls[0][1].body as URLSearchParams).get("token")).toBe("xoxc-selected");
	expect((fetch.mock.calls[0][1].body as URLSearchParams).get("team_id")).toBe("T123456");
});
it("rejects a response from a different organization or workspace before reading data", async () => {
	for (const identity of [
		{ enterprise_id: "E654321" },
		{ enterprise_id: "E123456", url: "https://other.slack.com/" },
	]) {
		const { read, fetch } = fixture({ context: "E123456", identity });
		expect((await read("conversations.list", {}, originalIdentity, workspace)).ok).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	}
});
it("does not guess among unrelated or ambiguous Enterprise sessions", async () => {
	for (const teams of [
		{ T654321: { domain: "unrelated", token: "xoxc-unrelated" } },
		{
			T123456: { domain: "fixture", token: "xoxc-one" },
			T654321: { domain: "fixture", token: "xoxc-two" },
		},
	]) {
		const { read, fetch } = fixture({ context: "E123456", teams });
		expect(await read("auth.test", {}, null, workspace)).toEqual({
			ok: false,
			error: "session_unavailable",
		});
		expect(fetch).not.toHaveBeenCalled();
	}
});
it("rejects account or team changes before reading conversations", async () => {
	for (const identity of [
		{ user_id: "U654321" },
		{ team_id: "T654321", enterprise_id: "E123456" },
	]) {
		const { read, fetch } = fixture({
			context: "E123456",
			identity: { enterprise_id: "E123456", ...identity },
		});
		expect(await read("conversations.list", {}, originalIdentity, workspace)).toEqual({
			ok: false,
			error: "identity_mismatch",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	}
});
it("reports fixed diagnostic codes without returning session or response content", async () => {
	const { read } = fixture({
		response: { ok: false, error: "invalid_auth", token: "xoxc-never-return" },
	});
	expect(await read("auth.test", {}, null, workspace)).toEqual({
		ok: false,
		error: "session_expired",
	});
	const unexpected = fixture({ response: { ok: false, error: "secret-provider-message" } });
	expect(await unexpected.read("auth.test", {}, null, workspace)).toEqual({
		ok: false,
		error: "provider_denied",
	});
});
it("rejects writes before making a provider request", async () => {
	const { read, fetch } = fixture();
	expect(await read("chat.postMessage", {}, null, workspace)).toEqual({
		ok: false,
		error: "invalid_request",
	});
	expect(fetch).not.toHaveBeenCalled();
});
