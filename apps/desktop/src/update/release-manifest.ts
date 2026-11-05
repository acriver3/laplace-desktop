import { createPublicKey, verify } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import {
	newer,
	revisionSchema,
	targetSchema,
	versionSchema,
	readJson,
	writeJson,
	updateRoot,
} from "./common";

const assetSchema = z
	.object({
		target: targetSchema,
		distribution: z.enum(["zip", "squirrel"]),
		name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(zip|nupkg)$/),
		size: z
			.number()
			.int()
			.positive()
			.max(2 ** 31),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict()
	.refine(({ target, distribution, name }) =>
		distribution === "zip"
			? name.endsWith(".zip")
			: target === "win32-x64" && name.endsWith("-full.nupkg"),
	);

export const manifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		tag: z
			.string()
			.regex(/^desktop-(?:[a-z]+-)*v[0-9]+\.[0-9]+\.[0-9]+$/)
			.optional(),
		qualified: z
			.array(
				z
					.object({
						target: targetSchema,
						distribution: z.enum(["source", "zip", "squirrel"]),
						evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
					})
					.strict(),
			)
			.optional(),
		version: versionSchema,
		commit: revisionSchema,
		assets: z.array(assetSchema).min(1).max(4),
	})
	.strict()
	.refine(
		({ assets }) =>
			new Set(assets.map(({ target, distribution }) => `${target}/${distribution}`)).size ===
				assets.length && new Set(assets.map(({ name }) => name)).size === assets.length,
	);

export type ReleaseManifest = z.infer<typeof manifestSchema>;

const maxManifestBytes = 64 * 1024;
const latest = "https://api.github.com/repos/acriver3/laplace-desktop/releases/latest";
const releaseAssets = "https://github.com/acriver3/laplace-desktop/releases/download";

export function verifyReleaseManifest(payload: Buffer, signature: Buffer, publicKey: string) {
	if (payload.length > maxManifestBytes || signature.length !== 64)
		throw new Error("Invalid release manifest size.");
	const key = createPublicKey(publicKey);
	if (key.asymmetricKeyType !== "ed25519" || !verify(null, payload, key, signature))
		throw new Error("Invalid release manifest signature.");
	return manifestSchema.parse(JSON.parse(payload.toString("utf8")));
}

async function boundedBody(response: Response, limit: number) {
	if (!response.ok || !response.body) throw new Error("Could not read public release metadata.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks, size);
			size += value.length;
			if (size > limit) throw new Error("Public release metadata exceeds its size limit.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
}

export async function checkPublicRelease(current: string, publicKey: string, signal: AbortSignal) {
	const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) };
	const metadata = await fetch(latest, options);
	if (metadata.status === 404) return;
	const release = z
		.object({ tag_name: z.string() })
		.parse(JSON.parse((await boundedBody(metadata, 256 * 1024)).toString("utf8")));
	if (!release.tag_name.startsWith("desktop-v")) throw new Error("Unexpected public release tag.");
	const version = versionSchema.parse(release.tag_name.slice("desktop-v".length));
	if (!newer(version, current)) return;
	const base = `${releaseAssets}/desktop-v${version}`;
	const [payload, signature] = await Promise.all([
		fetch(`${base}/update-manifest.json`, options).then((r) => boundedBody(r, maxManifestBytes)),
		fetch(`${base}/update-manifest.sig`, options).then((r) => boundedBody(r, 64)),
	]);
	const manifest = verifyReleaseManifest(payload, signature, publicKey);
	if (manifest.version !== version)
		throw new Error("Public release tag does not match its manifest.");
	return manifest;
}

export const indexSchema = z
	.object({
		schemaVersion: z.literal(1),
		sequence: z.number().int().positive(),
		releases: z.array(manifestSchema).min(1).max(500),
	})
	.strict()
	.refine(
		(index) =>
			new Set(index.releases.map((r) => r.tag ?? `desktop-v${r.version}`)).size ===
			index.releases.length,
		"Duplicate immutable desktop release",
	);
export function verifyDesktopIndex(payload: Buffer, signature: Buffer, key: string) {
	if (
		payload.length > 1024 * 1024 ||
		signature.length !== 64 ||
		createPublicKey(key).asymmetricKeyType !== "ed25519" ||
		!verify(null, payload, key, signature)
	)
		throw Error("Invalid desktop release index signature");
	return indexSchema.parse(JSON.parse(payload.toString("utf8")));
}
export async function checkReleaseIndex(
	current: string,
	publicKey: string,
	signal: AbortSignal,
	target: string,
	root = updateRoot(),
	distribution: "source" | "zip" | "squirrel" = "source",
) {
	const url =
		"https://raw.githubusercontent.com/acriver3/laplace-desktop/main/releases/stable.json";
	const options = {
		signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
		redirect: "error" as const,
	};
	const response = await fetch(url, options);
	if (response.status === 404) return checkPublicRelease(current, publicKey, signal);
	const [payload, signature] = await Promise.all([
		boundedBody(response, 1024 * 1024),
		fetch(url + ".sig", options).then((r) => boundedBody(r, 64)),
	]);
	const index = verifyDesktopIndex(payload, signature, publicKey);
	let old: z.infer<typeof indexSchema> | undefined;
	try {
		old = indexSchema.parse(await readJson(join(root, "release-index.json")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (
		old &&
		(index.sequence < old.sequence ||
			(index.sequence === old.sequence && JSON.stringify(old) !== JSON.stringify(index)))
	)
		throw Error("Desktop release index rollback rejected");
	for (const previous of old?.releases ?? []) {
		const match = index.releases.find(
			(r) =>
				(r.tag ?? `desktop-v${r.version}`) === (previous.tag ?? `desktop-v${previous.version}`),
		);
		if (!match || JSON.stringify(match) !== JSON.stringify(previous))
			throw Error("Immutable desktop release changed");
	}
	await writeJson(join(root, "release-index.json"), index);
	return index.releases
		.filter(
			(r) =>
				newer(r.version, current) &&
				r.assets.some(
					(a) =>
						a.target === target && (distribution === "source" || a.distribution === distribution),
				),
		)
		.sort((a, b) => (newer(a.version, b.version) ? -1 : 1))[0];
}
