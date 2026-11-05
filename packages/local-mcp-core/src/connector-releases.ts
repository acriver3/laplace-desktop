import { createHash, verify, createPublicKey } from "node:crypto";

import { z } from "zod";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const relativeFile = z
	.string()
	.min(1)
	.max(500)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!/[\\:\x00-\x1f]/.test(value) &&
			value
				.split("/")
				.every(
					(part) =>
						part !== ".." &&
						part !== "." &&
						part.length > 0 &&
						!/[ .]$/.test(part) &&
						!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
				),
	);
export const connectorRelease = z
	.object({
		id: z.string().regex(/^[a-z0-9-]+$/),
		version: z
			.string()
			.max(100)
			.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
		sequence: z.number().int().positive(),
		mode: z.enum(["tethered", "background-browser"]),
		channel: z.literal("stable"),
		platforms: z.array(z.enum(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"])).min(1),
		minDesktop: z.string().regex(/^\d+\.\d+\.\d+$/),
		minCli: z.string().regex(/^\d+\.\d+\.\d+$/),
		minBrowserProtocol: z.number().int().positive().optional(),
		sessionRevision: z.string().min(1).optional(),
		permissionRevision: z.string().min(1),
		configurationRevision: z.string().min(1),
		qualified: z.literal(true),
		qualificationSha256: digest,
		commit: z.string().regex(/^[a-f0-9]{40}$/),
		directory: relativeFile,
		files: z
			.array(
				z
					.object({
						path: relativeFile,
						sha256: digest,
						size: z
							.number()
							.int()
							.nonnegative()
							.max(256 * 1024 * 1024),
						executable: z.boolean(),
					})
					.strict(),
			)
			.min(1)
			.max(100000),
	})
	.strict()
	.superRefine((value, ctx) => {
		const paths = value.files.map((file) => file.path.toLowerCase());
		if (
			new Set(paths).size !== paths.length ||
			value.files.reduce((sum, file) => sum + file.size, 0) > 2 ** 31
		)
			ctx.addIssue({ code: "custom", message: "Duplicate files or excessive release size" });
	});
export type ConnectorRelease = z.infer<typeof connectorRelease>;
export const connectorIndex = z
	.object({
		schemaVersion: z.literal(1),
		sequence: z.number().int().positive(),
		releases: z.array(connectorRelease).max(1000),
	})
	.strict();
export type ConnectorIndex = z.infer<typeof connectorIndex>;
export const connectorReleaseKey = (r: ConnectorRelease) =>
	`${r.id}/${r.mode}/${r.version}/${[...r.platforms].sort().join(",")}`;
export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function boundedDownload(
	url: string,
	limit: number,
	signal: AbortSignal,
	fetcher = fetch,
) {
	const response = await fetcher(url, {
		signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
		redirect: "error",
	});
	if (!response.ok || !response.body) throw new Error("Verified update download is unavailable.");
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			size += item.value.length;
			if (size > limit) throw new Error("Update download exceeded its size limit");
			chunks.push(item.value);
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(chunks, size);
}
export function verifyConnectorIndex(payload: Buffer, signature: Buffer, key: string) {
	if (
		payload.length > 16 * 1024 * 1024 ||
		signature.length !== 64 ||
		createPublicKey(key).asymmetricKeyType !== "ed25519" ||
		!verify(null, payload, key, signature)
	)
		throw new Error("Connector release signature is invalid");
	const index = connectorIndex.parse(JSON.parse(payload.toString("utf8")));
	const keys = index.releases.flatMap((r) =>
		r.platforms.map((platform) => `${r.id}/${r.mode}/${r.version}/${platform}`),
	);
	if (new Set(keys).size !== keys.length) throw new Error("Duplicate connector release");
	return index;
}
export function assertIndexSuccessor(previous: ConnectorIndex | undefined, next: ConnectorIndex) {
	if (!previous) return;
	if (
		next.sequence < previous.sequence ||
		(next.sequence === previous.sequence && JSON.stringify(next) !== JSON.stringify(previous))
	)
		throw new Error("Connector catalog rollback or changed sequence rejected");
	for (const old of previous.releases) {
		const replacement = next.releases.find(
			(item) => connectorReleaseKey(item) === connectorReleaseKey(old),
		);
		if (replacement && JSON.stringify(old) !== JSON.stringify(replacement))
			throw new Error("Published connector version changed");
		if (!replacement) throw new Error("Connector release history must be retained");
	}
}
export function compatibleHost(current: string, minimum: string) {
	const a = current.split(".").map(Number),
		b = minimum.split(".").map(Number);
	if (a.length !== 3 || a.some((n) => !Number.isSafeInteger(n))) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i]! > b[i]!) return true;
		if (a[i]! < b[i]!) return false;
	}
	return true;
}

export const connectorSigningKey =
	"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAIPu7YOvnpdKag3R0YZTh0+JwEwkmXCOmWPdGSOPfT0k=\n-----END PUBLIC KEY-----\n";
