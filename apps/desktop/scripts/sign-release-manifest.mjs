import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [directory, keyPath, commit, ...extra] = process.argv.slice(2);
if (!directory || !keyPath || !/^[a-f0-9]{40}$/.test(commit ?? "") || extra.length)
	throw new Error("Usage: sign-release-manifest <validated-assets-directory> <private-key-file> <source-commit>");

const { version, releaseSigningPublicKey } = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
if (!releaseSigningPublicKey || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
	throw new Error("Configure the trusted public signing key and release version in package.json.");

const privateKey = createPrivateKey(await readFile(keyPath));
const publicKey = createPublicKey(releaseSigningPublicKey);
if (privateKey.asymmetricKeyType !== "ed25519" || !createPublicKey(privateKey).equals(publicKey))
	throw new Error("The signing key does not match the trusted release key.");

const assets = [];
for (const [target, distribution, name] of [
	...["darwin-arm64", "darwin-x64", "win32-x64"].map((target) => [
		target, "zip", `Laplace-${target}-${version}.zip`,
	]),
	["win32-x64", "squirrel", `Laplace-${version}-full.nupkg`],
]) {
	const path = join(directory, name);
	const info = await lstat(path);
	if (!info.isFile() || info.size < 1 || info.size > 2 ** 31)
		throw new Error(`Invalid release asset: ${name}`);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	assets.push({ target, distribution, name, size: info.size, sha256: hash.digest("hex") });
}

const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, version, commit, assets }, null, 2) + "\n");
await writeFile(join(directory, "update-manifest.sig"), sign(null, payload, privateKey), { flag: "wx" });
await writeFile(join(directory, "update-manifest.json"), payload, { flag: "wx" });
