import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { ServerConfig } from "./config";
import { systemEntry, type EntryFactory } from "./keychain-entry";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const receiptSchema = z
	.object({
		root: z.string(),
		catalogId: z.string(),
		provider: z.string(),
		version: z.string(),
		artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
		files: z.array(
			z.object({
				name: z.string().regex(/^[a-zA-Z0-9._-]+$/),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
			}),
		),
	})
	.strict();
export async function readRetainedRuntime(entryPath: string, entries?: EntryFactory) {
	const directory = dirname(entryPath);
	const proof = JSON.parse(await readFile(join(directory, ".laplace-retained.json"), "utf8"));
	const receipt = receiptSchema.parse(proof.receipt);
	if (
		!directory.startsWith(join(resolve(receipt.root), "retained-runtimes") + "/") &&
		!directory.startsWith(join(resolve(receipt.root), "retained-runtimes") + "\\")
	)
		throw Error("Invalid retained runtime directory");
	const key = (
		await (entries
			? entries("retained-runtime:key")
			: systemEntry(receipt.root, "retained-runtime:key"))
	).getPassword();
	if (!key) throw Error("Unlock the keychain to verify the retained connector runtime");
	const actual = Buffer.from(String(proof.mac), "hex"),
		expected = createHmac("sha256", Buffer.from(key, "base64"))
			.update(JSON.stringify(receipt))
			.digest();
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
		throw Error("Retained runtime ownership proof is invalid");
	if ((await lstat(directory)).isSymbolicLink()) throw Error("Linked runtime directory rejected");
	for (const file of receipt.files) {
		const path = join(directory, file.name);
		if ((await lstat(path)).isSymbolicLink() || digest(await readFile(path)) !== file.sha256)
			throw Error("Retained runtime integrity check failed");
	}
	if (
		!receipt.files.some(
			(file) => join(directory, file.name) === entryPath && file.sha256 === receipt.artifactSha256,
		)
	)
		throw Error("Retained runtime entry mismatch");
	return receipt;
}
/** Called only after the host verifies the existing managed configuration. */
export async function retainRuntime(
	root: string,
	resources: string,
	config: ServerConfig,
	entries: EntryFactory = (name) => systemEntry(root, name),
) {
	if (config.transport !== "stdio" || !config.managedBrowser || config.args.length !== 1)
		return config;
	const managed = config.managedBrowser,
		entry = config.args[0]!;
	if (!entry.startsWith(join(resources, "helper"))) return config;
	const manifest = JSON.parse(
		await readFile(join(resources, "browser-runtime-manifest.json"), "utf8"),
	);
	const names = [
		entry.slice(dirname(entry).length + 1),
		...(managed.provider === "slack-tethered"
			? [`slack-engine${process.platform === "win32" ? ".exe" : ""}`]
			: []),
	];
	const files = [];
	const bytes: Buffer[] = [];
	for (const name of names) {
		const value = await readFile(join(dirname(entry), name)),
			sha256 = digest(value);
		if (manifest.files[`helper/${name}`] !== sha256)
			throw Error("Installed runtime differs from its build inventory");
		files.push({ name, sha256 });
		bytes.push(value);
	}
	if (files[0]?.sha256 !== managed.artifactSha256)
		throw Error("Installed connector receipt mismatch");
	const receipt = {
		root: resolve(root),
		catalogId: managed.catalogId,
		provider: managed.provider,
		version: managed.runtimeVersion,
		artifactSha256: managed.artifactSha256,
		files,
	};
	const directory = join(root, "retained-runtimes", digest(Buffer.from(JSON.stringify(receipt))));
	const temporary = directory + "." + randomUUID();
	await mkdir(temporary, { recursive: true, mode: 0o700 });
	try {
		const account = await entries("retained-runtime:key");
		let key = account.getPassword();
		if (!key) {
			key = randomBytes(32).toString("base64");
			account.setPassword(key);
		}
		for (let i = 0; i < files.length; i++)
			await writeFile(join(temporary, files[i]!.name), bytes[i]!, { mode: 0o700, flag: "wx" });
		await writeFile(
			join(temporary, ".laplace-retained.json"),
			JSON.stringify({
				receipt,
				mac: createHmac("sha256", Buffer.from(key, "base64"))
					.update(JSON.stringify(receipt))
					.digest("hex"),
			}),
			{ mode: 0o600, flag: "wx" },
		);
		try {
			await rename(temporary, directory);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
				throw error;
			await readRetainedRuntime(join(directory, files[0]!.name));
		}
		return { ...config, args: [join(directory, files[0]!.name)] };
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
