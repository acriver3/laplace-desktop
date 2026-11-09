import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, expect, it, vi } from "vitest";

import { serverConfig } from "../src/config";
import {
	verifyConnectorIndex,
	assertIndexSuccessor,
	connectorIndex,
} from "../src/connector-releases";
import { ConnectorUpdates, type NpmUpdateHost } from "../src/connector-updates";
import { UpdatePolicyStore, automaticUpdatesEnabled } from "../src/update-policy";
const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(retain = false, npm?: NpmUpdateHost) {
	const root = await mkdtemp(join(tmpdir(), "laplace-updates-"));
	roots.push(root);
	const directory = join(root, "old");
	await mkdir(directory);
	await writeFile(join(directory, "server.mjs"), "old");
	await writeFile(join(directory, ".laplace-bundle.json"), JSON.stringify({ version: "0.1.0" }));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const key = publicKey.export({ type: "spki", format: "pem" }).toString();
	const release = (version: string, sequence: number, bytes: string) => ({
		id: "canvas-session-mcp",
		version,
		sequence,
		mode: (retain ? "tethered" : "background-browser") as "tethered" | "background-browser",
		channel: "stable" as const,
		platforms: [`${process.platform}-${process.arch}`] as any,
		minDesktop: "0.1.0",
		minCli: "0.1.0",
		permissionRevision: "reads-v1",
		configurationRevision: "config-v1",
		qualified: true as const,
		qualificationSha256: "a".repeat(64),
		commit: sequence.toString().repeat(40),
		directory: "bundles/example",
		files: [
			{
				path: "server.mjs",
				sha256: createHash("sha256").update(bytes).digest("hex"),
				size: bytes.length,
				executable: false,
			},
		],
	});
	let index = {
		schemaVersion: 1 as const,
		sequence: 1,
		releases: [release("0.1.0", 1, "old"), release("0.2.0", 2, "new")],
	};
	let config = serverConfig.parse({
		id: "canvas",
		name: "My Canvas",
		transport: "stdio",
		command: "node",
		args: [join(directory, "server.mjs")],
		identity: "canvas-session-mcp@0.1.0",
		...(retain
			? {
					managedBrowser: {
						catalogId: "canvas-session-mcp",
						provider: "outlook",
						workspace: "https://outlook.office.com",
						artifactSha256: createHash("sha256").update("old").digest("hex"),
						runtimeVersion: "0.1.0",
					},
				}
			: {}),
		env: {
			SESSION_DIR: join(root, "session"),
			LEGACY_PROFILE: join(directory, "profile"),
			TOKEN: "fixture-secret",
		},
	});
	const secrets = new Map<string, string>();
	const entries = async (name: string) => ({
		getPassword: () => secrets.get(name) ?? null,
		setPassword: (value: string) => {
			secrets.set(name, value);
		},
		deletePassword: () => {
			secrets.delete(name);
		},
	});
	const verify = vi.fn(async () => {}),
		releaseLock = vi.fn();
	const replace = vi.fn(async (next: typeof config) => {
		config = next;
	});
	const policy = new UpdatePolicyStore(join(root, "policy"));
	const fetcher = vi.fn(async (url: any) => {
		const payload = Buffer.from(JSON.stringify(index));
		if (String(url).endsWith("stable.json.sig"))
			return new Response(sign(null, payload, privateKey));
		if (String(url).endsWith("stable.json")) return new Response(payload);
		return new Response("new");
	}) as unknown as typeof fetch;
	const idleSeconds = vi.fn(async () => 900);
	const maintenance = vi.fn(async () => releaseLock);
	const busy = vi.fn(() => false);
	const updates = new ConnectorUpdates(
		{
			root,
			version: "0.1.24",
			kind: "desktop",
			entries,
			configurations: async () => [config],
			...(retain
				? {
						retainForEnrollment: async (current: typeof config) => {
							const retained = join(root, "retained");
							await mkdir(retained, { recursive: true });
							await writeFile(join(retained, "server.mjs"), "old");
							return { ...current, args: [join(retained, "server.mjs")] };
						},
					}
				: {}),
			replace,
			verify,
			maintenance,
			busy,
			idleSeconds,
			...(npm ? { npm } : {}),
		},
		policy,
		key,
		fetcher,
	);
	await updates.check();
	if (retain) await writeFile(join(directory, "other-helper.cjs"), "unrelated bundled helper");
	await updates.enroll(
		"canvas",
		directory,
		"canvas-session-mcp",
		"0.1.0",
		retain ? "tethered" : "background-browser",
	);
	return {
		updates,
		idleSeconds,
		maintenance,
		busy,
		fetcher,
		directory,
		policy,
		getConfig: () => config,
		replace,
		verify,
		releaseLock,
		changeIndex: (value: typeof index) => {
			index = value;
		},
		index,
		key,
		privateKey,
	};
}
it("keeps settings opt-in and persists independent choices", async () => {
	const f = await fixture();
	expect(await f.policy.read()).toMatchObject({ desktop: false, connectors: false, pins: {} });
	await f.policy.mutate((p) => {
		p.connectors = true;
	});
	expect(await f.policy.read()).toMatchObject({ desktop: false, connectors: true });
});
it("stages and replaces verified code while retaining account configuration", async () => {
	const f = await fixture(),
		previous = f.getConfig();
	await f.updates.apply("canvas");
	expect(f.getConfig().identity).toBe("canvas-session-mcp@0.2.0");
	expect(f.getConfig()).toMatchObject({
		id: previous.id,
		name: previous.name,
		env: previous.transport === "stdio" ? previous.env : undefined,
	});
	expect(f.verify).toHaveBeenCalledWith("canvas");
	expect(f.releaseLock).toHaveBeenCalledOnce();
	expect(await f.updates.status()).toMatchObject([{ version: "0.2.0" }]);
});
it("restores the previous configuration when candidate startup fails", async () => {
	const f = await fixture(),
		previous = f.getConfig();
	f.verify.mockRejectedValueOnce(Error("startup failed"));
	await expect(f.updates.apply("canvas")).rejects.toThrow("startup failed");
	expect(f.getConfig()).toEqual(previous);
	expect(f.releaseLock).toHaveBeenCalledOnce();
	expect((await f.updates.status())[0]?.message).toContain("Previous update failed");
});
it("honors both opt-in and pins for automatic application", async () => {
	const f = await fixture();
	vi.stubEnv("LAPLACE_AUTOMATIC_UPDATES_V1", "true");
	await f.updates.apply("canvas", true);
	expect(f.replace).not.toHaveBeenCalled();
	await f.policy.mutate((p) => {
		p.connectors = true;
	});
	await f.updates.pin("canvas", true);
	await f.updates.apply("canvas", true);
	expect(f.replace).not.toHaveBeenCalled();
	await f.updates.pin("canvas", false);
	await f.updates.apply("canvas", true);
	expect(f.replace).toHaveBeenCalledOnce();
});
it("does not silently change permission revisions", async () => {
	const f = await fixture();
	const index = structuredClone(f.index);
	index.sequence = 2;
	index.releases.push({
		...index.releases[1]!,
		version: "0.3.0",
		sequence: 3,
		permissionRevision: "writes-v2",
	});
	f.changeIndex(index);
	await f.updates.check();
	await expect(f.updates.apply("canvas")).rejects.toThrow("permission approval");
	expect(f.replace).not.toHaveBeenCalled();
});
it("rejects catalog rollback and immutable version replacement", async () => {
	const f = await fixture();
	const old = connectorIndex.parse(f.index),
		next = structuredClone(old);
	next.sequence = 2;
	next.releases[0]!.files[0]!.sha256 = "0".repeat(64);
	expect(() => assertIndexSuccessor(old, next)).toThrow("version changed");
	expect(() => assertIndexSuccessor({ ...old, sequence: 2 }, old)).toThrow("rollback");
});
it("rejects untrusted catalog signatures", async () => {
	const f = await fixture(),
		payload = Buffer.from(JSON.stringify(f.index));
	expect(() => verifyConnectorIndex(payload, Buffer.alloc(64), f.key)).toThrow("signature");
});

it("rejects tampered artifacts without changing the running configuration", async () => {
	const f = await fixture();
	vi.mocked(f.fetcher).mockResolvedValue(new Response("bad"));
	await expect(f.updates.apply("canvas")).rejects.toThrow("integrity");
	expect(f.replace).not.toHaveBeenCalled();
});
it("defers when work is active or maintenance cannot be acquired", async () => {
	const f = await fixture();
	f.busy.mockReturnValue(true);
	await expect(f.updates.apply("canvas")).rejects.toThrow("active");
	expect(f.replace).not.toHaveBeenCalled();
});
it("rechecks computer activity after acquiring maintenance", async () => {
	const f = await fixture();
	vi.stubEnv("LAPLACE_AUTOMATIC_UPDATES_V1", "true");
	await f.policy.mutate((p) => {
		p.connectors = true;
	});
	f.idleSeconds.mockResolvedValueOnce(900).mockResolvedValueOnce(0);
	await f.updates.apply("canvas", true);
	expect(f.replace).not.toHaveBeenCalled();
	expect(f.releaseLock).toHaveBeenCalledOnce();
});
it("cancels downloads when automation is disabled", async () => {
	const f = await fixture();
	await f.policy.mutate((p) => {
		p.connectors = true;
	});
	let entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	vi.mocked(f.fetcher).mockImplementation(async (_url, options) => {
		entered();
		return new Promise<Response>((_resolve, reject) =>
			options?.signal?.addEventListener("abort", () => reject(Error("cancelled")), {
				once: true,
			}),
		);
	});
	const pending = f.updates.prepare("canvas", undefined, true);
	const assertion = expect(pending).rejects.toThrow("cancelled");
	await started;
	await f.policy.mutate((p) => {
		p.connectors = false;
	});
	await assertion;
	expect(f.replace).not.toHaveBeenCalled();
});
it("accepts separate platform artifacts but rejects overlapping versions", async () => {
	const f = await fixture();
	const index = structuredClone(f.index);
	const second = { ...index.releases[0]!, platforms: ["win32-x64"] as any };
	index.releases[0]!.platforms = ["darwin-arm64"] as any;
	index.releases.push(second);
	const payload = Buffer.from(JSON.stringify(index));
	expect(
		verifyConnectorIndex(payload, sign(null, payload, f.privateKey), f.key).releases,
	).toHaveLength(3);
	index.releases.push(second);
	const duplicate = Buffer.from(JSON.stringify(index));
	expect(() => verifyConnectorIndex(duplicate, sign(null, duplicate, f.privateKey), f.key)).toThrow(
		"Duplicate",
	);
});

it("retains a verified tethered entry before enrolling a shared helper directory", async () => {
	const f = await fixture(true);
	expect(f.maintenance).toHaveBeenCalledWith("canvas");
	expect(f.releaseLock).toHaveBeenCalledOnce();
	expect(f.replace).toHaveBeenCalledOnce();
	const retained = f.getConfig();
	if (retained.transport !== "stdio") throw Error("Expected stdio");
	expect(retained.args[0]).toContain(join("retained", "server.mjs"));
	expect(retained.env.TOKEN).toBe("fixture-secret");
	expect(await f.updates.status()).toMatchObject([{ id: "canvas", version: "0.1.0" }]);
});

it.each([false, true])(
	"verifies compressed transport and extracted bytes (tampered=%s)",
	async (tampered) => {
		const f = await fixture();
		const index = structuredClone(f.index);
		index.sequence = 2;
		const packed = gzipSync(Buffer.from("new"));
		const candidate = structuredClone(index.releases[1]!);
		candidate.version = "0.3.0";
		candidate.sequence = 3;
		Object.assign(candidate.files[0]!, {
			compressed: {
				size: packed.length,
				sha256: createHash("sha256").update(packed).digest("hex"),
			},
		});
		index.releases.push(candidate);
		f.changeIndex(index);
		await f.updates.check();
		vi.mocked(f.fetcher).mockImplementation(async (url) => {
			if (String(url).endsWith(".gz"))
				return new Response(new Uint8Array(tampered ? Buffer.alloc(packed.length) : packed));
			throw Error("Unexpected artifact request");
		});
		if (tampered) {
			await expect(f.updates.apply("canvas")).rejects.toThrow("integrity");
			expect(f.replace).not.toHaveBeenCalled();
		} else {
			await f.updates.apply("canvas");
			expect(f.getConfig().identity).toBe("canvas-session-mcp@0.3.0");
		}
	},
);

it("enables the accepted rollout while retaining the explicit execution kill switch", async () => {
	vi.stubEnv("LAPLACE_AUTOMATIC_UPDATES_V1", undefined);
	expect(automaticUpdatesEnabled()).toBe(true);
	const f = await fixture();
	expect(await f.policy.read()).toMatchObject({ desktop: false, connectors: false });
	vi.stubEnv("LAPLACE_AUTOMATIC_UPDATES_V1", "false");
	expect(automaticUpdatesEnabled()).toBe(false);
	vi.stubEnv("LAPLACE_AUTOMATIC_UPDATES_V1", "invalid");
	expect(automaticUpdatesEnabled()).toBe(false);
	vi.stubEnv("LAPLACE_AUTOMATIC_UPDATES_V1", "true");
	expect(automaticUpdatesEnabled()).toBe(true);
});
it("migrates legacy bundles to npm and follows the npm dist-tag under the update policy", async () => {
	const state = { legacy: true, version: "0.1.0", latest: "0.3.0" };
	const npm = {
		targets: vi.fn(async () => [
			{ id: "canvas", name: "My Canvas", version: state.version, legacy: state.legacy },
		]),
		latest: vi.fn(async () => state.latest),
		stage: vi.fn(async () => {}),
		apply: vi.fn(async (_id: string, version: string) => {
			if (version === "0.4.0") throw Error("start failed");
			state.legacy = false;
			state.version = version;
		}),
	};
	const f = await fixture(false, npm);
	// The signed-feed enrollment is superseded by the npm distribution.
	expect(await f.updates.status()).toEqual([
		expect.objectContaining({
			id: "canvas",
			version: "0.1.0",
			availableVersion: "0.3.0",
			message: expect.stringContaining("legacy bundle"),
		}),
	]);
	// Migration follows the automatic-update policy: off, deferred and pinned all wait.
	expect(await f.updates.migrate()).toEqual([]);
	await f.policy.mutate((p) => {
		p.connectors = true;
		p.deferredUntil = Date.now() + 60_000;
	});
	expect(await f.updates.migrate()).toEqual([]);
	await f.policy.mutate((p) => {
		p.deferredUntil = 0;
	});
	await f.updates.pin("canvas", true);
	expect(await f.updates.migrate()).toEqual([]);
	await f.updates.pin("canvas", false);
	expect(npm.apply).not.toHaveBeenCalled();
	expect(await f.updates.migrate()).toEqual([{ id: "canvas" }]);
	expect(npm.apply).toHaveBeenLastCalledWith("canvas", "0.3.0", expect.anything());
	expect(f.releaseLock).toHaveBeenCalledOnce();
	expect(await f.updates.installed("canvas")).toBeUndefined();
	expect(await f.updates.migrate()).toEqual([]);

	state.latest = "0.4.0";
	await f.updates.check();
	vi.stubEnv("LAPLACE_AUTOMATIC_UPDATES_V1", "true");
	await f.policy.mutate((p) => {
		p.connectors = false;
	});
	await f.updates.apply("canvas", true);
	expect(npm.apply).toHaveBeenCalledOnce();
	await f.policy.mutate((p) => {
		p.connectors = true;
		p.deferredUntil = Date.now() + 60_000;
	});
	await f.updates.apply("canvas", true);
	expect(npm.apply).toHaveBeenCalledOnce();
	await f.policy.mutate((p) => {
		p.deferredUntil = 0;
	});
	await expect(f.updates.apply("canvas", true)).rejects.toThrow("start failed");
	expect((await f.updates.status())[0]).toMatchObject({
		version: "0.3.0",
		availableVersion: "0.4.0",
		message: expect.stringContaining("Previous update failed"),
	});
	await f.updates.apply("canvas", true);
	expect(npm.apply).toHaveBeenCalledTimes(2);
	state.latest = "0.5.0";
	await f.updates.check();
	await f.updates.prepare("canvas", undefined, true);
	expect(npm.stage).toHaveBeenLastCalledWith("canvas", "0.5.0", expect.anything());
	await f.updates.apply("canvas", true);
	expect(state.version).toBe("0.5.0");
	expect((await f.updates.status())[0]).toMatchObject({
		version: "0.5.0",
		availableVersion: undefined,
	});
	// A registry outage is reported without hiding the connector.
	npm.latest.mockRejectedValueOnce(Error("The npm registry could not be reached."));
	await f.updates.check();
	expect((await f.updates.status())[0]?.message).toBe("The npm registry could not be reached.");
});
