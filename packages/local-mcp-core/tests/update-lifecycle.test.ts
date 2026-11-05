import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ConnectorUpdates } from "@repo/local-mcp-core/connector-updates";
import { UpdatePolicyStore } from "@repo/local-mcp-core/update-policy";
import { it, expect } from "vitest";

import { serverConfig } from "../src/config";
import { Supervisor } from "../src/supervisor";
it("updates a real MCP process after queued work drains and rolls back failed discovery", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-update-lifecycle-"));
	const published: string[][] = [];
	const supervisor = new Supervisor(
		root,
		resolve("../../apps/desktop/resources"),
		() => {},
		async (p) => {
			published.push(p.toolNames);
		},
		async () => {},
	);
	try {
		const old = await readFile(resolve("tests/fixtures/mcp.mjs"), "utf8"),
			next = old + "\n// version 2\n",
			broken = "process.exit(1);";
		await mkdir(join(root, "installed"));
		await writeFile(join(root, "installed/server.mjs"), old);
		let config = serverConfig.parse({
			id: "fixture",
			name: "Preserved account",
			transport: "stdio",
			command: "node",
			args: [join(root, "installed/server.mjs")],
			identity: "fixture@1.0.0",
			env: { TEST_CREDENTIAL: "synthetic-credential" },
			enabledTools: ["read"],
		});
		const secrets = new Map<string, string>();
		const entries = async (key: string) => ({
			getPassword: () => secrets.get(key) ?? null,
			setPassword: (v: string) => {
				secrets.set(key, v);
			},
			deletePassword: () => {
				secrets.delete(key);
			},
		});
		const release = (version: string, sequence: number, bytes: string) => ({
			id: "fixture",
			version,
			sequence,
			mode: "background-browser",
			channel: "stable",
			platforms: [`${process.platform}-${process.arch}`],
			minDesktop: "0.1.0",
			minCli: "0.1.0",
			permissionRevision: "1",
			configurationRevision: "1",
			qualified: true,
			qualificationSha256: "a".repeat(64),
			commit: String(sequence).repeat(40),
			directory: "artifact",
			files: [
				{
					path: "server.mjs",
					size: Buffer.byteLength(bytes),
					sha256: createHash("sha256").update(bytes).digest("hex"),
					executable: false,
				},
			],
		});
		const index = {
			schemaVersion: 1,
			sequence: 1,
			releases: [release("1.0.0", 1, old), release("1.1.0", 2, next)],
		};
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const fetcher = async (url: any) => {
			const payload = Buffer.from(JSON.stringify(index));
			return new Response(
				String(url).endsWith(".sig")
					? sign(null, payload, privateKey)
					: String(url).endsWith("stable.json")
						? payload
						: String(url).includes("3".repeat(40))
							? broken
							: next,
			);
		};
		supervisor.configure([config]);
		await supervisor.start("fixture");
		expect(supervisor.states()[0]?.status).toBe("online");
		const updates = new ConnectorUpdates(
			{
				root,
				version: "1.0.0",
				kind: "cli",
				entries,
				configurations: async () => [config],
				busy: () => !!supervisor.activity(),
				maintenance: async (id) => supervisor.tryConnectorMaintenance(id),
				replace: async (value, expected) => {
					expect(config).toEqual(expected);
					await supervisor.remove("fixture");
					config = value;
					supervisor.configure([config]);
					await supervisor.start("fixture");
				},
				verify: async () => {
					if (supervisor.states()[0]?.status !== "online") throw Error("MCP discovery failed");
				},
			},
			new UpdatePolicyStore(join(root, "policy")),
			publicKey.export({ type: "spki", format: "pem" }).toString(),
			fetcher as typeof fetch,
		);
		await updates.check();
		await updates.enroll(
			"fixture",
			join(root, "installed"),
			"fixture",
			"1.0.0",
			"background-browser",
		);
		const invocation = () => ({
			localId: "fixture",
			revision: supervisor.states()[0]!.revision!,
			tool: "read",
			input: { delay: 100 },
		});
		const first = supervisor.call(invocation(), Date.now() + 3000, new AbortController()),
			second = supervisor.call(invocation(), Date.now() + 3000, new AbortController());
		await expect(updates.apply("fixture")).rejects.toThrow("active");
		await Promise.all([first, second]);
		await updates.apply("fixture");
		expect(config.identity).toBe("fixture@1.1.0");
		expect(config.enabledTools).toEqual(["read"]);
		const result = await supervisor.call(
			{ ...invocation(), input: {} },
			Date.now() + 3000,
			new AbortController(),
		);
		expect(JSON.parse((result.content as { text: string }[])[0]!.text).credential).toBe(
			"synthetic-credential",
		);
		index.sequence = 2;
		index.releases.push(release("1.2.0", 3, broken));
		await updates.check();
		await expect(updates.apply("fixture")).rejects.toThrow(/discovery failed/);
		expect(config.identity).toBe("fixture@1.1.0");
		expect(supervisor.states()[0]?.status).toBe("online");
		expect(published.length).toBeGreaterThan(1);
	} finally {
		await supervisor.shutdown();
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
