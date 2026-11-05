import { createPrivateKey, createPublicKey, sign, createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { verifyAcceptance } from "./update-acceptance.mjs";
const [input, keyFile, output, evidenceDirectory] = process.argv.slice(2);
if (!input || !keyFile || !output || !evidenceDirectory)
	throw Error(
		"Usage: sign-update-index <index.json> <key.pem> <output.json> <acceptance-directory>",
	);
const directory = await mkdtemp(join(tmpdir(), "laplace-index-schema-"));
try {
	const module = join(directory, "schema.mjs");
	await build({
		entryPoints: [new URL("../src/update/release-manifest.ts", import.meta.url).pathname],
		outfile: module,
		platform: "node",
		format: "esm",
		bundle: true,
	});
	const { indexSchema } = await import(pathToFileURL(module).href);
	const index = indexSchema.parse(JSON.parse(await readFile(input, "utf8")));
	const identities = index.releases.map((r) => r.tag ?? `desktop-v${r.version}`);
	if (new Set(identities).size !== identities.length)
		throw Error("Duplicate immutable desktop release");
	for (const release of index.releases)
		for (const qualification of release.qualified ?? []) {
			const evidence = await verifyAcceptance(
				evidenceDirectory,
				qualification.evidenceSha256,
				qualification.target,
				qualification.distribution,
			);
			if (
				evidence.commit !== release.commit ||
				(qualification.distribution !== "source" &&
					!release.assets.some(
						(a) =>
							a.target === qualification.target &&
							a.distribution === qualification.distribution &&
							a.sha256 === evidence.artifactSha256,
					))
			)
				throw Error("Acceptance does not cover this release artifact");
		}
	const key = createPrivateKey(await readFile(keyFile));
	if (key.asymmetricKeyType !== "ed25519") throw Error("Use an Ed25519 signing key");
	const bytes = Buffer.from(JSON.stringify(index));
	await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
	await writeFile(output + ".sig", sign(null, bytes, key), { flag: "wx", mode: 0o600 });
} finally {
	await rm(directory, { recursive: true, force: true });
}
