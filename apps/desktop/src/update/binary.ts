import { createHash, randomUUID } from "node:crypto";
import { writeFile, constants } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve, relative, isAbsolute, posix } from "node:path";

import { fromBuffer, type ZipFile, type Entry } from "yauzl";

import type { DesktopUpdateState } from "../shared/update-contracts";
import {
	assertDestination,
	squirrelDestination,
	exists,
	executable,
	nativeTarget,
	packageDigest,
	repository,
	requireSpace,
	run,
	runtimePath,
	writeJson,
	type Installation,
} from "./common";
import { access, mkdir, cp, rm } from "./filesystem";
import { stagedPackage } from "./installer";
import type { ReleaseManifest } from "./release-manifest";
import { probePackage } from "./source";

export async function adoptDownloadedApp(
	currentExecutable: string,
	version: string,
	root: string,
): Promise<Installation> {
	const target = nativeTarget();
	const path = target.startsWith("darwin")
		? resolve(currentExecutable, "../../..")
		: dirname(currentExecutable);
	assertDestination(path);
	if (executable(path, target) !== currentExecutable)
		throw Error("Move Laplace to its stable installation location first.");
	await access(dirname(path), constants.W_OK);
	await access(path, constants.W_OK);
	const node = join(
		runtimePath(path, target),
		"runtimes",
		target.startsWith("win32") ? "node.exe" : "node",
	);
	const installation: Installation = {
		protocol: 1,
		distribution: squirrelDestination(path) ? "squirrel" : "zip",
		id: randomUUID(),
		owner: userInfo().username,
		repository,
		target,
		path,
		version,
		commit: "unknown",
		git: node,
		node,
		pnpm: node,
		toolPath: dirname(node),
	};
	if (
		installation.distribution === "squirrel" &&
		!(await exists(join(dirname(path), "Update.exe")))
	)
		throw Error("Squirrel installation needs repair");
	await writeJson(join(root, "installation.json"), installation);
	return installation;
}

/** Validate every archive path before the platform extractor sees any bytes. */
export async function inspectApplicationZip(bytes: Buffer) {
	const zip = await new Promise<ZipFile>((resolve, reject) =>
		fromBuffer(
			bytes,
			{ lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
			(error, zip) => (error || !zip ? reject(error ?? Error("Invalid ZIP")) : resolve(zip)),
		),
	);
	const paths = new Set<string>();
	const links = new Set<string>();
	let size = 0,
		count = 0;
	try {
		await new Promise<void>((done, reject) => {
			zip.on("error", reject);
			zip.on("end", done);
			zip.on("entry", (entry: Entry) => {
				void (async () => {
					const name = entry.fileName.replace(/\/$/, "");
					const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
					if (
						!name ||
						name.startsWith("/") ||
						/[\\:\x00-\x1f]/.test(name) ||
						name.split("/").some((p) => !p || p === "." || p === ".." || /[ .]$/.test(p)) ||
						paths.has(name.toLowerCase()) ||
						entry.generalPurposeBitFlag & 1 ||
						++count > 100000 ||
						(size += entry.uncompressedSize) > 8 * 1024 ** 3 ||
						![0, 0o100000, 0o040000, 0o120000].includes(kind)
					)
						throw Error("Unsafe application archive");
					paths.add(name.toLowerCase());
					if (kind === 0o120000) {
						if (entry.uncompressedSize > 4096) throw Error("Invalid archive link");
						const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
							zip.openReadStream(entry, (e, s) => (e || !s ? rej(e) : res(s))),
						);
						const chunks: Buffer[] = [];
						for await (const chunk of stream) chunks.push(Buffer.from(chunk));
						const target = Buffer.concat(chunks).toString("utf8");
						const resolved = posix.relative("/archive", posix.resolve("/archive", posix.dirname(name), target));
						if (
							isAbsolute(target) ||
							/[\\:\x00-\x1f]/.test(target) ||
							resolved === ".." ||
							resolved.startsWith("../")
						)
							throw Error("Archive link escapes application");
						links.add(name.toLowerCase());
					}
					zip.readEntry();
				})().catch(reject);
			});
			zip.readEntry();
		});
		for (const path of paths)
			for (const link of links)
				if (path.startsWith(link + "/")) throw Error("Archive writes through a symbolic link");
	} finally {
		zip.close();
	}
}

export async function prepareBinary(
	installation: Installation,
	release: ReleaseManifest,
	root: string,
	phase: (value: DesktopUpdateState["phase"]) => void,
	signal: AbortSignal,
	probeOptions?: Parameters<typeof probePackage>[5],
) {
	const artifact = release.assets.find(
		(asset) => asset.target === installation.target && asset.distribution === "zip",
	);
	if (!artifact) throw Error("No qualified application package is available for this platform.");
	await requireSpace(root);
	phase("downloading");
	const tag = release.tag ?? `desktop-v${release.version}`;
	const response = await fetch(
		`https://github.com/acriver3/laplace-desktop/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifact.name)}`,
		{ signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]) },
	);
	if (!response.ok || !response.body) throw Error("Application download unavailable");
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.length;
			if (size > artifact.size) throw Error("Application exceeds signed size");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = Buffer.concat(chunks, size);
	if (
		size !== artifact.size ||
		createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
	)
		throw Error("Application signature manifest checksum mismatch");
	phase("verifying");
	await inspectApplicationZip(bytes);
	const id = randomUUID(),
		directory = join(root, "staging", id),
		extracted = join(directory, "extracted");
	await mkdir(extracted, { recursive: true, mode: 0o700 });
	try {
		const archive = join(directory, "application.zip");
		await writeFile(archive, bytes, { mode: 0o600, flag: "wx" });
		if (process.platform === "darwin")
			await run("/usr/bin/ditto", ["-x", "-k", archive, extracted], { signal });
		else {
			const script = join(directory, "extract.ps1");
			await writeFile(
				script,
				'param([string]$archive,[string]$destination)\n$ErrorActionPreference = "Stop"\nExpand-Archive -LiteralPath $archive -DestinationPath $destination\n',
				{ mode: 0o600, flag: "wx" },
			);
			await run(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-File", script, archive, extracted],
				{ signal },
			);
		}
		const app = installation.target.startsWith("darwin")
			? join(extracted, "Laplace.app")
			: extracted;
		const candidate = stagedPackage(root, id);
		await cp(app, candidate, { recursive: true, verbatimSymlinks: true });
		await probePackage(candidate, installation.target, release.version, root, signal, probeOptions);
		signal.throwIfAborted();
		if (installation.distribution === "squirrel") {
			const squirrel = release.assets.find(
				(a) => a.target === installation.target && a.distribution === "squirrel",
			);
			if (!squirrel) throw Error("Signed Squirrel package is missing from this release");
			const response = await fetch(
				`https://github.com/acriver3/laplace-desktop/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(squirrel.name)}`,
				{ signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]) },
			);
			if (!response.ok || !response.body) throw Error("Squirrel package unavailable");
			const chunks: Uint8Array[] = [];
			let size = 0;
			const reader = response.body.getReader();
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					size += next.value.length;
					if (size > squirrel.size) throw Error("Squirrel package exceeds signed size");
					chunks.push(next.value);
				}
			} finally {
				await reader.cancel();
			}
			const bytes = Buffer.concat(chunks, size);
			if (
				size !== squirrel.size ||
				createHash("sha256").update(bytes).digest("hex") !== squirrel.sha256
			)
				throw Error("Squirrel package integrity failure");
			const feed = join(candidate, ".laplace-squirrel");
			await mkdir(feed, { mode: 0o700 });
			await writeFile(join(feed, squirrel.name), bytes, { mode: 0o600, flag: "wx" });
			await writeFile(
				join(feed, "RELEASES"),
				`${createHash("sha1").update(bytes).digest("hex").toUpperCase()} ${squirrel.name} ${size}\n`,
				{ mode: 0o600, flag: "wx" },
			);
		}
		await writeJson(join(root, "pending.json"), {
			id,
			installationId: installation.id,
			version: release.version,
			commit: release.commit,
			digest: await packageDigest(candidate),
		});
		await rm(extracted, { recursive: true, force: true });
		await rm(archive, { force: true });
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}
