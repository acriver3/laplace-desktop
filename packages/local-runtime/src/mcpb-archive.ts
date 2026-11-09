import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fromBuffer, type Entry, type ZipFile } from "yauzl";

// User-imported MCPB bundles (custom connectors). Catalog connectors install from npm.
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 20000;
const abortError = () => new Error("Operation cancelled.");
const assertActive = (signal?: AbortSignal) => {
	if (signal?.aborted) throw abortError();
};

export function safeArchivePath(name: string) {
	if (
		!name ||
		name.includes("\\") ||
		name.includes(":") ||
		name.split("").some((character) => character.charCodeAt(0) < 32) ||
		name.startsWith("/")
	)
		throw new Error("Archive contains an unsafe path.");
	const parts = name.replace(/\/$/, "").split("/");
	if (
		parts.some(
			(part) =>
				!part ||
				part === "." ||
				part === ".." ||
				/[ .]$/.test(part) ||
				/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
		)
	)
		throw new Error("Archive contains an unsafe path.");
	return parts.join("/");
}

/** Safe bounded extraction; callers verify archive identity before invoking it. */
export async function extractBundle(bytes: Buffer, destination: string, signal?: AbortSignal) {
	await mkdir(destination, { recursive: true, mode: 0o700 });
	assertActive(signal);
	const zip = await new Promise<ZipFile>((accept, reject) =>
		fromBuffer(
			bytes,
			{ lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true },
			(error, value) =>
				error || !value ? reject(error ?? new Error("Invalid archive.")) : accept(value),
		),
	);
	const seen = new Set<string>();
	let count = 0,
		expanded = 0;
	await new Promise<void>((accept, reject) => {
		let settled = false;
		const fail = (error: unknown) => {
			if (!settled) {
				settled = true;
				zip.close();
				reject(error);
			}
		};
		const aborted = () => fail(abortError());
		signal?.addEventListener("abort", aborted, { once: true });
		zip.once("error", fail);
		zip.once("end", () => {
			if (!settled) {
				settled = true;
				signal?.removeEventListener("abort", aborted);
				accept();
			}
		});
		zip.on("entry", (entry: Entry) => {
			void (async () => {
				assertActive(signal);
				const name = safeArchivePath(entry.fileName);
				const identity = name.normalize("NFC").toLowerCase();
				const mode = entry.externalFileAttributes >>> 16;
				const kind = mode & 0o170000;
				if (
					seen.has(identity) ||
					++count > MAX_ARCHIVE_FILES ||
					(kind !== 0 && kind !== 0o100000 && kind !== 0o040000) ||
					entry.generalPurposeBitFlag & 1
				)
					throw new Error("Archive contains duplicate, encrypted, linked, or unsupported files.");
				seen.add(identity);
				if (
					!Number.isSafeInteger(entry.uncompressedSize) ||
					entry.uncompressedSize < 0 ||
					(expanded += entry.uncompressedSize) > MAX_EXPANDED_BYTES
				)
					throw new Error("Archive exceeds the expanded size limit.");
				const target = join(destination, name);
				if (entry.fileName.endsWith("/")) {
					await mkdir(target, { recursive: true, mode: 0o700 });
					zip.readEntry();
					return;
				}
				if (kind === 0o040000) throw new Error("Archive directory has an invalid filename.");
				await mkdir(dirname(target), { recursive: true, mode: 0o700 });
				const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
					zip.openReadStream(entry, (error, value) =>
						error || !value ? rej(error ?? new Error("Missing archive entry.")) : res(value),
					),
				);
				const file = await open(target, "wx", mode & 0o111 ? 0o755 : 0o600);
				let written = 0;
				try {
					for await (const chunk of stream) {
						assertActive(signal);
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						written += buffer.length;
						if (written > entry.uncompressedSize)
							throw new Error("Archive entry exceeds its declared size.");
						await file.writeFile(buffer);
					}
					if (written !== entry.uncompressedSize) throw new Error("Archive entry is truncated.");
				} finally {
					await file.close();
				}
				zip.readEntry();
			})().catch(fail);
		});
		zip.readEntry();
	}).finally(() => zip.close());
}
