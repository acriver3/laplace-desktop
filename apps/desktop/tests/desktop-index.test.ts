import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it, expect, vi } from "vitest";

import { verifyDesktopIndex, checkReleaseIndex } from "../src/update/release-manifest";
it("selects independent platform/distribution releases and rejects rollback and tampering", async () => {
	const root = await mkdtemp(join(tmpdir(), "desktop-index-"));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519"),
		key = publicKey.export({ type: "spki", format: "pem" }).toString();
	const asset = (target: string, distribution: string, name: string) => ({
		target,
		distribution,
		name,
		size: 1,
		sha256: "a".repeat(64),
	});
	const index = {
		schemaVersion: 1,
		sequence: 2,
		releases: [
			{
				tag: "desktop-macos-v1.1.0",
				schemaVersion: 1,
				version: "1.1.0",
				commit: "1".repeat(40),
				assets: [asset("darwin-arm64", "zip", "Laplace.zip")],
			},
			{
				tag: "desktop-windows-v1.2.0",
				schemaVersion: 1,
				version: "1.2.0",
				commit: "2".repeat(40),
				assets: [asset("win32-x64", "zip", "Laplace.zip")],
			},
			{
				tag: "desktop-windows-v1.3.0",
				schemaVersion: 1,
				version: "1.3.0",
				commit: "3".repeat(40),
				assets: [asset("win32-x64", "squirrel", "Laplace-full.nupkg")],
			},
		],
	};
	const bytes = () => Buffer.from(JSON.stringify(index));
	vi.stubGlobal(
		"fetch",
		async (url: string) =>
			new Response(url.endsWith(".sig") ? sign(null, bytes(), privateKey) : bytes()),
	);
	try {
		expect(
			(
				await checkReleaseIndex(
					"1.0.0",
					key,
					new AbortController().signal,
					"darwin-arm64",
					root,
					"zip",
				)
			)?.version,
		).toBe("1.1.0");
		expect(
			(
				await checkReleaseIndex(
					"1.0.0",
					key,
					new AbortController().signal,
					"win32-x64",
					root,
					"zip",
				)
			)?.version,
		).toBe("1.2.0");
		expect(
			await checkReleaseIndex(
				"1.0.0",
				key,
				new AbortController().signal,
				"darwin-x64",
				root,
				"zip",
			),
		).toBeUndefined();
		expect(() => verifyDesktopIndex(bytes(), Buffer.alloc(64), key)).toThrow("signature");
		index.sequence = 1;
		await expect(
			checkReleaseIndex("1.0.0", key, new AbortController().signal, "darwin-arm64", root),
		).rejects.toThrow("rollback");
	} finally {
		vi.unstubAllGlobals();
		await rm(root, { recursive: true, force: true });
	}
});
