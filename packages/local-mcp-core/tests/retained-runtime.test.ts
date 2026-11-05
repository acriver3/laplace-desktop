import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { serverConfig } from "../src/config";
import { retainRuntime, readRetainedRuntime } from "../src/retained-runtime";
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("retains the exact runtime independently of later application replacement", async () => {
	const root = await mkdtemp(join(tmpdir(), "retained-runtime-"));
	roots.push(root);
	const resources = join(root, "app", "runtime");
	await mkdir(join(resources, "helper"), { recursive: true });
	const bytes = Buffer.from("fixture"),
		sha256 = createHash("sha256").update(bytes).digest("hex");
	await writeFile(join(resources, "helper", "outlook-browser.cjs"), bytes);
	await writeFile(
		join(resources, "browser-runtime-manifest.json"),
		JSON.stringify({ files: { "helper/outlook-browser.cjs": sha256 } }),
	);
	const config = serverConfig.parse({
		id: "outlook",
		name: "Work outlook",
		transport: "stdio",
		command: "node",
		args: [join(resources, "helper", "outlook-browser.cjs")],
		identity: "msoutlook-mcp@0.1.0",
		managedBrowser: {
			catalogId: "msoutlook-mcp",
			provider: "outlook",
			workspace: "https://outlook.cloud.microsoft",
			runtimeVersion: "0.1.0",
			artifactSha256: sha256,
		},
	});
	let secret: string | null = null;
	const entries = async () => ({
		getPassword: () => secret,
		setPassword: (v: string) => {
			secret = v;
		},
		deletePassword: () => {
			secret = null;
		},
	});
	const retained = await retainRuntime(root, resources, config, entries);
	if (retained.transport !== "stdio") throw Error("Expected stdio");
	await rm(join(root, "app"), { recursive: true });
	expect(await readRetainedRuntime(retained.args[0]!, entries)).toMatchObject({
		version: "0.1.0",
		artifactSha256: sha256,
	});
	await writeFile(retained.args[0]!, "tampered");
	await expect(readRetainedRuntime(retained.args[0]!, entries)).rejects.toThrow("integrity");
});
