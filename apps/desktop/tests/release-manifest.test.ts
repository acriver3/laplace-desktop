import { generateKeyPairSync, sign } from "node:crypto";

import { expect, it } from "vitest";

import { verifyReleaseManifest } from "../src/update/release-manifest";

it("authenticates the release bytes before trusting the target and digest", () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const key = publicKey.export({ type: "spki", format: "pem" }).toString();
	const asset = {
		target: "win32-x64",
		distribution: "squirrel",
		name: "Laplace-0.1.11-full.nupkg",
		size: 42,
		sha256: "a".repeat(64),
	};
	const manifest = {
		schemaVersion: 1,
		version: "0.1.11",
		commit: "b".repeat(40),
		assets: [asset],
	};
	const payload = Buffer.from(JSON.stringify(manifest));
	const signature = sign(null, payload, privateKey);
	expect(verifyReleaseManifest(payload, signature, key)).toEqual(manifest);
	expect(() => verifyReleaseManifest(Buffer.concat([payload, Buffer.from(" ")]), signature, key))
		.toThrow("Invalid release manifest signature");
	for (const invalid of [
		{ ...manifest, assets: [asset, asset] },
		{ ...manifest, assets: [{ ...asset, target: "darwin-arm64" }] },
		{ ...manifest, assets: [{ ...asset, name: "../untrusted.nupkg" }] },
	]) {
		const bytes = Buffer.from(JSON.stringify(invalid));
		expect(() => verifyReleaseManifest(bytes, sign(null, bytes, privateKey), key)).toThrow();
	}
});
