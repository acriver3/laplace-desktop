import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EntryFactory } from "@repo/local-mcp-core/store";
import { CredentialBroker, type CredentialPrincipal } from "@repo/local-runtime/credentials";
import { cdpOrigin, browserTargets } from "@repo/local-runtime/credentials-cdp";
import {
	executeCommand,
	publicV4,
	selectedResult,
	validateParameters,
} from "@repo/local-runtime/credentials-execution";
import { credentialInput, credentialSettings } from "@repo/project-protocol/credentials";
import { afterEach, expect, it, vi } from "vitest";

const cleanup: Array<() => Promise<unknown> | void> = [];
it.skipIf(process.platform === "win32")(
	"injects into a real child process and drops reflected credentials from its output",
	async () => {
		const secret = "synthetic-process-credential";
		const result = await executeCommand(
			{
				id: randomUUID(),
				label: "Synthetic",
				credentialId: randomUUID(),
				kind: "command",
				executable: process.execPath,
				cwd: tmpdir(),
				args: [
					"-e",
					"process.stdout.write(JSON.stringify({ok:!!process.env.SAMPLE_TOKEN,leak:process.env.SAMPLE_TOKEN}))",
				],
				env: { SAMPLE_TOKEN: "password" },
				parameters: {},
				resultFields: ["ok", "leak"],
			},
			{},
			{ SAMPLE_TOKEN: secret },
			"/unused",
			AbortSignal.timeout(5000),
		);
		expect(result).toEqual({ exitCode: 0, fields: { ok: true } });
		expect(JSON.stringify(result)).not.toContain(secret);
	},
);
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
	vi.unstubAllGlobals();
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "laplace-credential-test-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const entriesMap = new Map<string, string>();
	const entries: EntryFactory = async (key) => ({
		getPassword: () => entriesMap.get(key) ?? null,
		setPassword: (v) => {
			entriesMap.set(key, v);
		},
		deletePassword: () => {
			entriesMap.delete(key);
		},
	});
	const id = randomUUID(),
		itemId = randomUUID(),
		clientId = randomUUID();
	let authorized = true;
	const principal: CredentialPrincipal = {
		id: `local:${clientId}`,
		name: "Test agent",
		hosted: false,
		authorize: () => {
			if (!authorized) throw new Error("revoked");
		},
	};
	const secret = "test-only-secret-9a8b",
		session = "test-session";
	const bw = vi.fn(async (_path: string, args: string[]) =>
		args[0] === "unlock"
			? session
			: JSON.stringify({
					id: itemId,
					login: {
						password: secret,
						username: "test-user",
						uris: [{ uri: "https://example.com/login" }],
					},
				}),
	);
	const executors = {
		browserTargets: vi.fn(async () => [
			{ id: "tab", origin: "https://example.com", socket: "ws://127.0.0.1:9222/devtools/page/tab" },
		]),
		fillBrowser: vi.fn(async () => ({ filledFields: 1, origin: "https://example.com" })),
		executeHttp: vi.fn(async () => ({ status: 200, fields: {} })),
		executeCommand: vi.fn(async () => ({ exitCode: 0, fields: {} })),
	};
	const broker = new CredentialBroker(root, "/unused", () => {}, entries, bw, executors);
	cleanup.push(() => broker.close());
	await broker.initialize();
	const settings = credentialSettings.parse({
		enabled: true,
		hosted: true,
		clients: [clientId],
		cdpEndpoint: "http://127.0.0.1:9222",
		bindings: [
			{ id, itemId, label: "Example", origins: ["https://example.com", "https://evil.example"] },
		],
	});
	await broker.configure(settings);
	await broker.unlock("test-master");
	const input = {
		action: "fill",
		requestId: randomUUID(),
		credentialId: id,
		targetId: "tab",
		fields: ["password"],
	};
	const wait = async () => {
		await vi.waitFor(() => expect(executors.fillBrowser).toHaveBeenCalledTimes(1));
		await vi.waitFor(async () =>
			expect(
				await broker.call(principal, { action: "result", requestId: input.requestId }),
			).toMatchObject({ status: "complete" }),
		);
	};
	return {
		broker,
		root,
		entries,
		bw,
		executors,
		id,
		itemId,
		principal,
		settings,
		input,
		secret,
		wait,
		revoke: () => {
			authorized = false;
		},
	};
}
it("keeps credentials out of pending/results/storage and intersects vault origins with local policy", async () => {
	const f = await fixture();
	expect(await f.broker.call(f.principal, f.input)).toMatchObject({ status: "pending" });
	expect(f.executors.fillBrowser).not.toHaveBeenCalled();
	await f.broker.approve(f.principal.id, f.input.requestId, true, false);
	await f.wait();
	expect(f.executors.fillBrowser.mock.calls[0]).toEqual(
		expect.arrayContaining([["https://example.com"], { password: f.secret }]),
	);
	const result = await f.broker.call(f.principal, {
		action: "result",
		requestId: f.input.requestId,
	});
	expect(JSON.stringify(result)).not.toContain(f.secret);
	expect(JSON.stringify(f.broker.snapshot())).not.toContain(f.secret);
	expect(
		(await readFile(join(f.root, "credentials.enc"))).includes(Buffer.from("test-master")),
	).toBe(false);
});
it("denial is final, duplicates do not execute, and changed-input retries are rejected", async () => {
	const f = await fixture();
	await f.broker.call(f.principal, f.input);
	await f.broker.approve(f.principal.id, f.input.requestId, false, false);
	expect(await f.broker.call(f.principal, f.input)).toMatchObject({ status: "denied" });
	expect(f.executors.fillBrowser).not.toHaveBeenCalled();
	await expect(f.broker.call(f.principal, { ...f.input, targetId: "another-tab" })).rejects.toThrow(
		"different input",
	);
});
it("concurrent approvals execute at most once and grants are confined to exact scope", async () => {
	const f = await fixture();
	await f.broker.call(f.principal, f.input);
	await Promise.allSettled([
		f.broker.approve(f.principal.id, f.input.requestId, true, true),
		f.broker.approve(f.principal.id, f.input.requestId, true, true),
	]);
	await f.wait();
	expect(
		await f.broker.call(f.principal, {
			...f.input,
			requestId: randomUUID(),
			targetId: "another-tab",
		}),
	).toMatchObject({ status: "pending" });
	await f.broker.call(f.principal, { ...f.input, requestId: randomUUID() });
	await vi.waitFor(() => expect(f.executors.fillBrowser).toHaveBeenCalledTimes(2));
	f.broker.lock();
	expect(f.broker.snapshot().grants).toEqual([]);
});
it("rechecks authorization after fetching the credential and before filling", async () => {
	const f = await fixture();
	await f.broker.call(f.principal, f.input);
	f.bw.mockImplementationOnce(async () => {
		f.revoke();
		return JSON.stringify({
			id: f.itemId,
			login: { password: f.secret, uris: [{ uri: "https://example.com" }] },
		});
	});
	await f.broker.approve(f.principal.id, f.input.requestId, true, false);
	await vi.waitFor(() => expect(f.bw).toHaveBeenCalledTimes(2));
	expect(f.executors.fillBrowser).not.toHaveBeenCalled();
});
it("prevents another client from reading a result or consuming a grant", async () => {
	const f = await fixture();
	await f.broker.call(f.principal, f.input);
	await f.broker.approve(f.principal.id, f.input.requestId, true, true);
	await f.wait();
	const other = { ...f.principal, id: `local:${randomUUID()}` };
	await expect(
		f.broker.call(other, { action: "result", requestId: f.input.requestId }),
	).rejects.toThrow("Enable credential access");
});
it("requires local approval for a new hosted principal even for credential metadata", async () => {
	const f = await fixture();
	const hosted = { ...f.principal, id: "hosted:example", hosted: true };
	expect(await f.broker.call(hosted, { action: "list", requestId: randomUUID() })).toMatchObject({
		status: "pending",
	});
});
it("does not replay a previously accepted request after restarting the broker", async () => {
	const f = await fixture();
	await f.broker.call(f.principal, f.input);
	f.broker.close();
	const restarted = new CredentialBroker(f.root, "/unused", () => {}, f.entries, f.bw, f.executors);
	cleanup.push(() => restarted.close());
	await restarted.initialize();
	expect(await restarted.call(f.principal, f.input)).toMatchObject({ status: "unavailable" });
	expect(f.executors.fillBrowser).not.toHaveBeenCalled();
});
it("cancels a pending operation when settings change", async () => {
	const f = await fixture();
	await f.broker.call(f.principal, f.input);
	await f.broker.configure(f.settings);
	await expect(f.broker.approve(f.principal.id, f.input.requestId, true, false)).rejects.toThrow();
	expect(f.executors.fillBrowser).not.toHaveBeenCalled();
});
it("rejects arbitrary commands, URLs, and additional fields in agent input", () => {
	expect(
		credentialInput.safeParse({
			action: "run",
			requestId: randomUUID(),
			actionId: randomUUID(),
			command: "env",
		}).success,
	).toBe(false);
	expect(
		credentialInput.safeParse({
			action: "fill",
			requestId: randomUUID(),
			credentialId: randomUUID(),
			targetId: "tab",
			fields: ["password"],
			cdpEndpoint: "http://attacker",
		}).success,
	).toBe(false);
	for (const url of [
		"http://localhost:9222",
		"http://example.com:9222",
		"http://127.0.0.1:9222/path",
		"http://a:b@127.0.0.1:9222",
	])
		expect(() => cdpOrigin(url)).toThrow();
});
it("excludes tabs whose CDP WebSocket points off the configured browser", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify([
						{
							id: "tab",
							type: "page",
							url: "https://example.com",
							webSocketDebuggerUrl: "ws://evil.example/devtools/page/tab",
						},
					]),
				),
		),
	);
	expect(await browserTargets("http://127.0.0.1:9222", new AbortController().signal)).toEqual([]);
});
it("returns only approved scalar fields and removes known raw and encoded secrets", () => {
	const s = "test-secret",
		raw = JSON.stringify({
			message: s,
			encoded: Buffer.from(s).toString("base64"),
			ok: true,
			nested: { password: s },
			unapproved: "anything",
		});
	expect(selectedResult(raw, ["message", "encoded", "ok", "nested"], [s])).toEqual({ ok: true });
	expect(selectedResult("not json", ["message"], [s])).toEqual({});
	for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "100.64.0.1", "::1"])
		expect(publicV4(ip)).toBe(false);
	expect(publicV4("8.8.8.8")).toBe(true);
});
it("validates configured parameter choices before invoking an executable", () => {
	const action = credentialSettings.parse({ actions: [] }).actions;
	expect(action).toEqual([]);
	expect(() =>
		validateParameters({ parameters: { mode: ["safe"] } } as any, { mode: "--eval=evil" }),
	).toThrow();
});

it("autosaving access choices keeps the vault unlocked and revokes pending approvals", async () => {
	const f = await fixture();
	await f.broker.call(f.principal, f.input);
	await f.broker.configure({ ...f.settings, setupStep: "assistants" }, true);
	expect(f.broker.snapshot().unlocked).toBe(true);
	await expect(f.broker.approve(f.principal.id, f.input.requestId, true, false)).rejects.toThrow();
	expect(f.executors.fillBrowser).not.toHaveBeenCalled();
});
it("connection changes still lock the vault even through autosave", async () => {
	const f = await fixture();
	await f.broker.configure({ ...f.settings, bitwardenServer: "https://vault.bitwarden.eu" }, true);
	expect(f.broker.snapshot().unlocked).toBe(false);
});
it("refuses to reuse selected logins for another managed account", async () => {
	const f = await fixture();
	await f.broker.configure({
		...f.settings,
		managedBitwarden: true,
		bitwardenAccountId: randomUUID(),
	});
	vi.spyOn(f.broker.connection, "signIn").mockImplementation(async (_input, accept) =>
		accept("synthetic-session", randomUUID()),
	);
	await expect(
		f.broker.signIn({ email: "other@example.invalid", password: "synthetic" }),
	).rejects.toMatchObject({ code: "account_mismatch" });
	expect(f.broker.snapshot().unlocked).toBe(false);
});
it("unlock cannot bypass the selected account check", async () => {
	const f = await fixture();
	await f.broker.configure({
		...f.settings,
		managedBitwarden: true,
		bitwardenAccountId: randomUUID(),
	});
	vi.spyOn(f.broker.connection, "command").mockImplementation(async (args) =>
		args[0] === "unlock"
			? "synthetic-session"
			: JSON.stringify({ userId: randomUUID(), userEmail: "other@example.invalid" }),
	);
	await expect(f.broker.unlock("synthetic")).rejects.toMatchObject({ code: "account_mismatch" });
	expect(f.broker.snapshot().unlocked).toBe(false);
});

it("loads every supported vault login instead of silently stopping at 1,000", async () => {
	const f = await fixture();
	const logins = Array.from({ length: 1005 }, (_, i) => ({
		id: randomUUID(),
		type: 1,
		name: `Login ${i}`,
		login: { password: f.secret, uris: [{ uri: "https://example.com" }] },
	}));
	f.bw.mockResolvedValueOnce(
		JSON.stringify([
			...logins,
			{ ...logins[0], id: randomUUID(), deletedDate: "2026-01-01" },
			{ id: randomUUID(), type: 2, notes: f.secret },
		]),
	);
	const items = await f.broker.items();
	expect(items).toHaveLength(1005);
	expect(items.at(-1)?.id).toBe(logins.at(-1)?.id);
	expect(JSON.stringify(items)).not.toContain(f.secret);
});
it("keeps large selections unlocked and exposes all metadata through bounded pages", async () => {
	const f = await fixture();
	const bindings = [
		...f.settings.bindings,
		...Array.from({ length: 240 }, () => ({
			id: randomUUID(),
			itemId: randomUUID(),
			label: "界".repeat(90),
			origins: ["https://example.com"],
		})),
	];
	const action = {
		id: randomUUID(),
		credentialId: f.id,
		label: "Existing action",
		kind: "http",
		url: "https://example.com/status",
		method: "GET",
		header: "Authorization",
		prefix: "Bearer ",
		field: "password",
		parameters: {},
		resultFields: [],
	};
	await f.broker.configure({ ...f.settings, bindings, actions: [action] }, true);
	expect(f.broker.snapshot().unlocked).toBe(true);
	const ids: string[] = [],
		actions: string[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const response = (await f.broker.call(f.principal, {
			action: "list",
			requestId: randomUUID(),
			...(cursor ? { cursor } : {}),
		})) as {
			status: string;
			result: {
				credentials: Array<{ id: string }>;
				actions: Array<{ id: string }>;
				nextCursor?: string;
			};
		};
		expect(response.status).toBe("complete");
		expect(Buffer.byteLength(JSON.stringify(response.result))).toBeLessThan(48000);
		ids.push(...response.result.credentials.map((v) => v.id));
		actions.push(...response.result.actions.map((v) => v.id));
		cursor = response.result.nextCursor;
		if (++pages > 10) throw new Error("Pagination did not advance");
	} while (cursor);
	expect(ids).toEqual(bindings.map((b) => b.id));
	expect(actions).toEqual([action.id]);
	expect(pages).toBeGreaterThan(1);
	expect(
		credentialInput.safeParse({ action: "list", requestId: randomUUID(), cursor: "-1" }).success,
	).toBe(false);
});

it("requires explicit whole-vault matching and strips values, notes and TOTP from discovery", async () => {
	const f = await fixture();
	expect(f.settings.wholeVaultMatching).toBe(false);
	expect(await f.broker.brokerCandidates(f.principal)).toEqual([
		{ id: f.id, label: "Example", origins: f.settings.bindings[0]!.origins },
	]);
	const item = {
		id: f.itemId,
		type: 1,
		name: "Example account",
		notes: "private-note-canary",
		login: {
			username: "synthetic-user",
			password: f.secret,
			totp: "private-totp-canary",
			uris: [{ uri: "https://example.com/login" }],
		},
	};
	const second = { ...item, id: randomUUID(), name: "Example other account" };
	f.bw.mockImplementation(async (_path, args) =>
		args[0] === "unlock"
			? "test-session"
			: JSON.stringify(args[0] === "list" ? [item, second] : item),
	);
	await f.broker.configure({ ...f.settings, wholeVaultMatching: true }, true);
	const candidates = await f.broker.brokerCandidates(f.principal);
	expect(candidates).toHaveLength(2);
	expect(candidates[0]?.origins).toEqual(["https://example.com"]);
	expect(JSON.stringify(candidates)).not.toMatch(
		/synthetic-user|private-note|private-totp|test-only-secret/,
	);
	const use = vi.fn(async (values: Record<string, string>) => {
		expect(values).toEqual({ username: "synthetic-user", password: f.secret });
		return "filled";
	});
	expect(await f.broker.withBrokerLogin(f.principal, f.itemId, "https://example.com", use)).toBe(
		"filled",
	);
	await expect(
		f.broker.withBrokerLogin(f.principal, f.itemId, "https://evil.example", use),
	).rejects.toThrow();
	await f.broker.configure(f.settings, true);
	await expect(
		f.broker.withBrokerLogin(f.principal, second.id, "https://example.com", use),
	).rejects.toThrow();
});
it("requires per-assistant hosted matching authorization and revokes it immediately", async () => {
	const f = await fixture(),
		principal = { ...f.principal, id: "hosted:fixture", hosted: true };
	await expect(f.broker.brokerCandidates(principal)).rejects.toThrow("Authorize");
	await f.broker.authorizeBrokerAssistant(principal);
	expect(await f.broker.brokerCandidates(principal)).toHaveLength(1);
	await f.broker.configure({ ...f.settings, brokerAssistants: [] }, true);
	await expect(f.broker.brokerCandidates(principal)).rejects.toThrow();
});

it("reviews a one-time local command and binds approval to its complete mapping", async () => {
	const f = await fixture();
	const input = {
		action: "run_command",
		requestId: randomUUID(),
		credentialId: f.id,
		command: {
			executable: process.execPath,
			cwd: tmpdir(),
			args: ["agent.js"],
			env: { TOKEN: "password", USER: "username" },
			runtimeSeconds: 120,
		},
	};
	expect(await f.broker.call(f.principal, input)).toMatchObject({ status: "pending" });
	expect(f.executors.executeCommand).not.toHaveBeenCalled();
	const pending = f.broker.snapshot().pending[0]!;
	expect(pending).toMatchObject({ oneTimeOnly: true });
	expect(pending.summary).toContain("TOKEN");
	expect(pending.summary).toContain(process.execPath);
	expect(JSON.stringify(pending)).not.toContain(f.secret);
	await expect(
		f.broker.call(f.principal, { ...input, command: { ...input.command, args: ["different.js"] } }),
	).rejects.toThrow("different input");
	await Promise.allSettled([
		f.broker.approve(f.principal.id, input.requestId, true, true),
		f.broker.approve(f.principal.id, input.requestId, true, true),
	]);
	await vi.waitFor(() => expect(f.executors.executeCommand).toHaveBeenCalledTimes(1));
	expect(f.executors.executeCommand.mock.calls[0]).toEqual(
		expect.arrayContaining([{ TOKEN: f.secret, USER: "test-user" }]),
	);
	expect(f.executors.executeCommand).toHaveBeenCalledWith(
		expect.objectContaining({ resultFields: [] }),
		{},
		expect.any(Object),
		"/unused",
		expect.any(AbortSignal),
		true,
	);
	await f.broker.call(f.principal, input);
	expect(f.executors.executeCommand).toHaveBeenCalledTimes(1);
	const next = { ...input, requestId: randomUUID() };
	expect(await f.broker.call(f.principal, next)).toMatchObject({ status: "pending" });
	await f.broker.approve(f.principal.id, next.requestId, false, false);
	expect(f.executors.executeCommand).toHaveBeenCalledTimes(1);
});
it("rejects hosted command proposals, relative paths, and command TOTP mappings", async () => {
	const f = await fixture();
	const input = {
		action: "run_command",
		requestId: randomUUID(),
		credentialId: f.id,
		command: {
			executable: process.execPath,
			cwd: tmpdir(),
			env: { TOKEN: "password" },
		},
	};
	await expect(
		f.broker.call(f.principal, { ...input, command: { ...input.command, executable: "node" } }),
	).rejects.toThrow("absolute");
	expect(
		credentialInput.safeParse({ ...input, command: { ...input.command, env: { TOKEN: "totp" } } })
			.success,
	).toBe(false);
	await f.broker.configure({ ...f.settings, hosted: true });
	await expect(f.broker.call({ ...f.principal, hosted: true }, input)).rejects.toThrow(
		"locally registered",
	);
	expect(f.executors.executeCommand).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")(
	"runs a real proposed command with literal arguments and withholds all output",
	async () => {
		const result = await executeCommand(
			{
				id: randomUUID(),
				label: "Canary command",
				credentialId: randomUUID(),
				kind: "command",
				executable: process.execPath,
				cwd: tmpdir(),
				args: [
					"-e",
					"process.stdout.write(JSON.stringify({leak:process.env.TOKEN})); process.stderr.write(process.env.TOKEN); process.exit(process.argv[1] === '{{literal}}' && !!process.env.TOKEN ? 0 : 1);",
					"{{literal}}",
				],
				env: { TOKEN: "password" },
				parameters: {},
				resultFields: ["leak"],
			},
			{},
			{ TOKEN: "synthetic-command-canary" },
			"/unused",
			AbortSignal.timeout(5000),
			true,
		);
		expect(result).toEqual({ exitCode: 0, fields: {} });
		expect(JSON.stringify(result)).not.toContain("synthetic-command-canary");
	},
);
it("revokes a pending command on vault lock without executing it", async () => {
	const f = await fixture();
	const input = {
		action: "run_command",
		requestId: randomUUID(),
		credentialId: f.id,
		command: { executable: process.execPath, cwd: tmpdir(), env: { TOKEN: "password" } },
	};
	await f.broker.call(f.principal, input);
	f.broker.lock();
	await expect(f.broker.approve(f.principal.id, input.requestId, true, false)).rejects.toThrow();
	expect(f.executors.executeCommand).not.toHaveBeenCalled();
});
