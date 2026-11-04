import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { spawnLocal, stopTree } from "@repo/local-mcp-core/process";
import { afterEach, expect, it, vi } from "vitest";

import {
	BitwardenConnectionManager,
	loginPrompt,
	BITWARDEN_VERSION,
} from "../src/helper/bitwarden-connection";
import { bitwardenError } from "../src/helper/credential-errors";
import { helperInputs } from "../src/shared/helper-contracts";
vi.mock("@repo/local-mcp-core/process", () => ({
	spawnLocal: vi.fn(),
	stopTree: vi.fn(async () => {}),
}));
const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
	for (const f of cleanup.splice(0).reverse()) await f();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});
function child() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
	});
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "laplace-bw-setup-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const manager = new BitwardenConnectionManager(root, join(root, "resources"), () => {});
	cleanup.push(() => manager.cancel());
	const childProcess = child();
	vi.mocked(spawnLocal).mockReturnValue(childProcess as never);
	const account = randomUUID();
	const command = vi
		.spyOn(manager, "command")
		.mockImplementation(async (args, token) =>
			args[0] === "status"
				? JSON.stringify(
						token
							? { userId: account, userEmail: "synthetic@example.invalid", status: "unlocked" }
							: { status: "unauthenticated" },
					)
				: "",
		);
	return { root, manager, childProcess, account, command };
}
it("recognizes verification prompts without returning arbitrary CLI output", () => {
	expect(loginPrompt("private-value\n? Two-step login code:")).toEqual({ challenge: "code" });
	expect(loginPrompt("? New device verification required. Enter OTP sent to login email:")).toEqual(
		{ challenge: "device_code" },
	);
	expect(loginPrompt("? API key client_secret:")).toEqual({ challenge: "api_secret" });
	expect(
		loginPrompt(
			"? Two-step login method:\n❯ Authenticator\n  Email\n  YubiKey\n  Cancel\nprivate-value",
		),
	).toEqual({ challenge: "method", methods: ["Authenticator", "Email", "YubiKey"] });
	expect(loginPrompt("unknown prompt with private-value")).toBeUndefined();
});
it("keeps passwords and challenge answers out of arguments, snapshots and accepted metadata", async () => {
	const f = await fixture(),
		accept = vi.fn(async () => {});
	await f.manager.signIn(
		{ email: "synthetic@example.invalid", password: "synthetic-master" },
		accept,
	);
	const [, args, , env] = vi.mocked(spawnLocal).mock.calls[0]!;
	expect(args.join(" ")).not.toContain("synthetic-master");
	expect(env.LAPLACE_BW_MASTER).toBe("synthetic-master");
	expect(env.BITWARDENCLI_APPDATA_DIR).toBe(join(f.root, "bitwarden-vault"));
	f.childProcess.stderr.write("? Two-step login code:");
	await vi.waitFor(() =>
		expect(f.manager.snapshot()).toMatchObject({ phase: "challenge", challenge: "code" }),
	);
	f.manager.answer("123456");
	expect(f.childProcess.stdin.read().toString()).toBe("123456\n");
	const token = "c3ludGhldGljLXNlc3Npb24tdG9rZW4=";
	f.childProcess.stdout.write(token);
	f.childProcess.emit("close", 0);
	await vi.waitFor(() => expect(accept).toHaveBeenCalledExactlyOnceWith(token, f.account));
	await vi.waitFor(() => expect(f.manager.snapshot().phase).toBe("connected"));
	const snapshot = JSON.stringify(f.manager.snapshot());
	for (const value of ["synthetic-master", "123456", token]) expect(snapshot).not.toContain(value);
});
it("ignores late credentials and prompts after cancellation", async () => {
	const f = await fixture(),
		accept = vi.fn(async () => {});
	await f.manager.signIn(
		{ email: "synthetic@example.invalid", password: "synthetic-master" },
		accept,
	);
	f.manager.cancel();
	f.childProcess.stderr.write("? Two-step login code:");
	f.childProcess.stdout.write("c3ludGhldGljLXNlc3Npb24tdG9rZW4=");
	f.childProcess.emit("close", 0);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(accept).not.toHaveBeenCalled();
	expect(f.manager.snapshot().challenge).toBeUndefined();
	expect(stopTree).toHaveBeenCalled();
});
it("deduplicates child error/close and reports only safe errors", async () => {
	const f = await fixture(),
		accept = vi.fn(async () => {});
	await f.manager.signIn(
		{ email: "synthetic@example.invalid", password: "synthetic-master" },
		accept,
	);
	f.childProcess.stderr.write("Username or password is incorrect. secret=synthetic-master");
	f.childProcess.emit("error", new Error("synthetic-master"));
	f.childProcess.emit("close", 1);
	await vi.waitFor(() => expect(f.manager.snapshot().error).toBe("incorrect_password"));
	expect(JSON.stringify(f.manager.snapshot())).not.toContain("synthetic-master");
	expect(accept).not.toHaveBeenCalled();
});
it("uses environment-only personal API keys and unlocks separately", async () => {
	const f = await fixture(),
		accept = vi.fn(async () => {});
	f.command.mockImplementation(async (args, token) =>
		args[0] === "unlock"
			? "c3ludGhldGljLXNlc3Npb24tdG9rZW4="
			: args[0] === "status"
				? JSON.stringify(
						token ? { userId: f.account, status: "unlocked" } : { status: "unauthenticated" },
					)
				: "",
	);
	await f.manager.signIn(
		{
			email: "synthetic@example.invalid",
			password: "synthetic-master",
			clientId: "user.synthetic",
			clientSecret: "synthetic-api-key",
		},
		accept,
	);
	const [, args, , env] = vi.mocked(spawnLocal).mock.calls[0]!;
	expect(args).toContain("--apikey");
	expect(args.join(" ")).not.toContain("synthetic-api-key");
	expect(env.BW_CLIENTSECRET).toBe("synthetic-api-key");
	f.childProcess.emit("close", 0);
	await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce());
	expect(f.command.mock.calls.some(([args]) => args[0] === "unlock")).toBe(true);
});
it("rejects tampered runtime manifests before any executable runs and allows retry", async () => {
	const f = await fixture();
	const resources = join(f.root, "resources", "bitwarden");
	await mkdir(resources, { recursive: true });
	await writeFile(
		join(resources, "package-lock.json"),
		JSON.stringify({ packages: { "node_modules/@bitwarden/cli": { integrity: "sha512-wrong" } } }),
	);
	await expect(f.manager.prepare()).rejects.toMatchObject({ code: "download" });
	expect(spawnLocal).not.toHaveBeenCalled();
	await expect(f.manager.prepare()).rejects.toMatchObject({ code: "download" });
});
it("pins all dependency downloads to public registry integrity entries", async () => {
	const lock = JSON.parse(
		await readFile(
			new URL("../runtime-manifests/bitwarden/package-lock.json", import.meta.url),
			"utf8",
		),
	);
	expect(lock.packages["node_modules/@bitwarden/cli"].version).toBe(BITWARDEN_VERSION);
	for (const [name, value] of Object.entries(lock.packages) as Array<
		[string, { resolved?: string; integrity?: string }]
	>)
		if (name) {
			expect(value.resolved).toMatch(/^https:\/\/registry.npmjs.org\//);
			expect(value.integrity).toMatch(/^sha512-/);
		}
});
it("disconnect removes only Laplace's isolated profile", async () => {
	const f = await fixture();
	await mkdir(f.manager.appData, { recursive: true });
	await writeFile(join(f.manager.appData, "data.json"), "synthetic");
	await writeFile(join(f.root, "external-profile.json"), "preserve");
	await f.manager.disconnect();
	await expect(readFile(join(f.manager.appData, "data.json"))).rejects.toThrow();
	expect(await readFile(join(f.root, "external-profile.json"), "utf8")).toBe("preserve");
});
it("classifies failures without exposing provider messages and rejects control characters in answers", () => {
	for (const [input, code] of [
		["Your authentication request appears to be coming from a bot.", "api_key_required"],
		["ENOTFOUND", "network"],
		["vault locked", "expired"],
		["SSO trusted device encryption", "unsupported"],
	])
		expect(bitwardenError(input).code).toBe(code);
	expect(bitwardenError("unexpected private-value").message).not.toContain("private-value");
	expect(helperInputs["credentials.answer"].safeParse({ value: "123\n456" }).success).toBe(false);
});
