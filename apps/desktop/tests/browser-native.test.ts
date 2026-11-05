import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable, PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { BrowserConnectionRelay } from "../src/helper/browser-connection-relay";
import {
	nativeBrowserOrigin,
	registerBrowserNativeHost,
	runBrowserNativeHost,
} from "../src/main/browser-native-host";
import { browserExtensionId } from "../src/shared/browser-extension-id";
import {
	browserHostName,
	listBrowserRequests,
	publishBrowserRequest,
} from "../src/shared/browser-requests";
import { approveBrowser } from "./fixtures/browser-approval";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
	const value = await mkdtemp(join(tmpdir(), "browser-native-test-"));
	roots.push(value);
	return value;
}
function message(value: unknown) {
	const body = Buffer.from(JSON.stringify(value)),
		head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
}
it("streams pending requests without a popup and closes when the browser disconnects", async () => {
	const directory = await root(),
		input = new PassThrough(),
		frames: any[] = [];
	const output = new Writable({
		write(chunk, _encoding, done) {
			frames.push(JSON.parse(Buffer.from(chunk).subarray(4).toString()));
			done();
		},
	});
	const running = runBrowserNativeHost(nativeBrowserOrigin, input, output, directory);
	input.write(message({ method: "watch_pending" }));
	await vi.waitFor(() => expect(frames).toHaveLength(1));
	await publishBrowserRequest(
		{
			id: randomUUID(),
			provider: "slack",
			environment: "fixture",
			workspace: "https://fixture.slack.com",
			pairingUrl: "http://127.0.0.1:1234/#" + "a".repeat(43),
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		},
		directory,
	);
	await vi.waitFor(() => expect(frames.at(-1).requests).toHaveLength(1), { timeout: 2000 });
	input.end();
	await running;
	const count = frames.length;
	await new Promise((r) => setTimeout(r, 800));
	expect(frames).toHaveLength(count);
});
it("discovers active requests via framed native messaging and rejects other extensions or methods", async () => {
	const directory = await root(),
		id = randomUUID();
	const remove = await publishBrowserRequest(
		{
			id,
			provider: "slack",
			environment: "hosted",
			workspace: "https://fixture.slack.com",
			pairingUrl: "http://127.0.0.1:1234/#" + "a".repeat(43),
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		},
		directory,
	);
	await writeFile(join(directory, randomUUID() + ".json"), '{"invalid":"do not return"}');
	const out: Buffer[] = [];
	const output = new Writable({
		write(chunk, _encoding, callback) {
			out.push(Buffer.from(chunk));
			callback();
		},
	});
	const frame = message({ method: "list_pending" });
	await runBrowserNativeHost(
		nativeBrowserOrigin,
		Readable.from([frame.subarray(0, 2), frame.subarray(2)]),
		output,
		directory,
	);
	const reply = Buffer.concat(out);
	expect(reply.readUInt32LE(0)).toBe(reply.length - 4);
	expect(JSON.parse(reply.subarray(4).toString()).requests.map((r: any) => r.id)).toEqual([id]);
	await expect(
		runBrowserNativeHost("chrome-extension://other/", Readable.from([frame]), output, directory),
	).rejects.toThrow("Unrecognized");
	await expect(
		runBrowserNativeHost(
			nativeBrowserOrigin,
			Readable.from([message({ method: "approve" })]),
			output,
			directory,
		),
	).rejects.toThrow("Unknown");
	await remove();
	expect(await listBrowserRequests(directory)).toEqual([]);
});
it("registers only the Laplace extension with the existing executable and preserves foreign manifests", async () => {
	vi.stubEnv("LAPLACE_TETHERED_BROWSER_V1", "false");
	const home = await root(),
		registerWindows = vi.fn(async () => {});
	await registerBrowserNativeHost("/resources", {
		home,
		platform: "win32",
		registerWindows,
	});
	const path = join(home, ".laplace-desktop/native-messaging", browserHostName + ".json");
	expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
		path: join("/resources", "runtimes", "browser-native-host.exe"),
		allowed_origins: [nativeBrowserOrigin],
	});
	expect(registerWindows).toHaveBeenCalledWith(path);
	await writeFile(path, JSON.stringify({ name: browserHostName, allowed_origins: ["other"] }));
	await expect(
		registerBrowserNativeHost("/different", { home, platform: "win32", registerWindows }),
	).rejects.toThrow("unrelated");
});
it("reuses the transport for a second provider and isolates each approval and request", async () => {
	const a = new BrowserConnectionRelay({
		id: "fixture-a",
		label: "Fixture A",
		workspace: "https://a.example",
		identitySchema: z.object({ workspace: z.string(), userId: z.string() }),
		reads: { read: { method: "items.list", schema: z.object({}).strict() } },
	});
	const b = new BrowserConnectionRelay({
		id: "fixture-b",
		label: "Fixture B",
		workspace: "https://b.example",
		identitySchema: z.object({ workspace: z.string(), userId: z.string() }),
		reads: { read: { method: "records.list", schema: z.object({}).strict() } },
	});
	await a.listen();
	await b.listen();
	try {
		const first = new URL(a.pairing().pairingUrl),
			second = new URL(b.pairing().pairingUrl);
		const post = (url: URL, path: string, body: unknown, token?: string) =>
			fetch(url.origin + path, {
				method: "POST",
				headers: {
					Origin: "chrome-extension://" + browserExtensionId,
					"Content-Type": "application/json",
					...(token ? { Authorization: "Bearer " + token } : {}),
				},
				body: JSON.stringify(body),
			});
		const { token } = await (
			await approveBrowser(a, (path, body) => post(first, path, body), first.hash.slice(1), {
				workspace: "https://a.example",
				userId: "user-a",
			})
		).json();
		expect(
			(
				await post(second, "/pair", {
					code: second.hash.slice(1),
					identity: { workspace: "https://a.example", userId: "user-a" },
				})
			).status,
		).toBe(400);
		expect((await post(second, "/next", {}, token)).status).toBe(400);
		expect(a.status().connected).toBe(true);
		expect(b.status().connected).toBe(false);
		b.disconnect();
		expect(a.status().connected).toBe(true);
	} finally {
		await a.close();
		await b.close();
	}
});
