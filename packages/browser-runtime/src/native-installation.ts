import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { browserExtensionId } from "./browser-extension-id";
import { browserHostName } from "./browser-requests";

export const nativeRuntimeVersion = "0.3.0";
export const nativeProtocolVersion = 1;
const extensionOrigin = `chrome-extension://${browserExtensionId}/`;
const versionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const installationSchema = z.object({
	version: versionSchema,
	protocol: z.number().int().positive(),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	owners: z.array(z.enum(["desktop", "cli"])),
	files: z.partialRecord(
		z.enum([
			"runtimes/node",
			"runtimes/node.exe",
			"helper/browser-native-entry.cjs",
			"runtimes/browser-native-host.exe",
		]),
		z.string().regex(/^[a-f0-9]{64}$/),
	),
});
type Options = {
	home?: string;
	platform?: string;
	client?: "desktop" | "cli";
	version?: string;
	protocol?: number;
	registerWindows?: (path: string) => Promise<void>;
};
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
function compare(a: string, b: string) {
	const aa = versionSchema.parse(a).split(".").map(Number);
	const bb = versionSchema.parse(b).split(".").map(Number);
	return aa[0]! - bb[0]! || aa[1]! - bb[1]! || aa[2]! - bb[2]!;
}
async function atomic(path: string, contents: string, mode: number) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, contents, { mode, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
async function readInstallation(root: string) {
	try {
		return installationSchema.parse(
			JSON.parse(await readFile(join(root, "installation.json"), "utf8")),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
/** Shared per-user lock; a crash never permits two registrations to overwrite each other. */
async function locked<T>(root: string, work: () => Promise<T>): Promise<T> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const path = join(root, "installation.lock");
	const deadline = Date.now() + 15_000;
	while (true) {
		try {
			await mkdir(path, { mode: 0o700 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline)
				throw Error(
					"Browser runtime registration is locked. Retry shortly; if no installer is running, remove the stale installation.lock directory under ~/.laplace/browser.",
				);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600 });
		return await work();
	} finally {
		await rm(path, { recursive: true, force: true });
	}
}
function directories(home: string, platform: string) {
	return platform === "win32"
		? [join(home, ".laplace-desktop", "native-messaging")]
		: platform === "darwin"
			? [
					join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
					join(home, "Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
				]
			: [
					join(home, ".config/google-chrome/NativeMessagingHosts"),
					join(home, ".config/microsoft-edge/NativeMessagingHosts"),
					join(home, ".config/chromium/NativeMessagingHosts"),
				];
}
async function checkManifest(path: string) {
	const previous = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (previous) {
		const value = JSON.parse(previous);
		if (
			value.name !== browserHostName ||
			JSON.stringify(value.allowed_origins) !== JSON.stringify([extensionOrigin])
		)
			throw Error("An unrelated native host registration exists.");
	}
}
async function registerWindows(path: string) {
	for (const browser of ["Google\\Chrome", "Microsoft\\Edge"]) {
		const key = `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${browserHostName}`;
		const existing = await promisify(execFile)("reg.exe", ["query", key, "/ve"], {
			windowsHide: true,
		}).catch(() => null);
		const previous = existing?.stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
		if (previous && previous.toLowerCase() !== path.toLowerCase())
			throw Error("A different native host registration already exists.");
		await promisify(execFile)("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", path, "/f"], {
			windowsHide: true,
		});
	}
}
/** Copy the native executable and bundled entry out of either client's installation.
 * The newest compatible version remains installed even when its supplying client is removed.
 */
export async function installBrowserNativeHost(resources: string, options: Options = {}) {
	const home = options.home ?? homedir(),
		platform = options.platform ?? process.platform;
	const root = join(home, ".laplace", "browser");
	const version = versionSchema.parse(options.version ?? nativeRuntimeVersion);
	const protocol = options.protocol ?? nativeProtocolVersion;
	const client = options.client ?? "desktop";
	return locked(root, async () => {
		const previous = await readInstallation(root);
		if (previous && previous.protocol !== protocol)
			throw Error(
				"Installed browser runtime protocol is incompatible. Update both Laplace clients.",
			);
		const paths = directories(home, platform).map((dir) => join(dir, `${browserHostName}.json`));
		for (const path of paths) await checkManifest(path);
		let installed = previous;
		if (!previous || compare(version, previous.version) >= 0) {
			const files = [
				`runtimes/${platform === "win32" ? "node.exe" : "node"}`,
				"helper/browser-native-entry.cjs",
				...(platform === "win32" ? ["runtimes/browser-native-host.exe"] : []),
			];
			const hashes: Record<string, string> = {};
			for (const file of files) hashes[file] = hash(await readFile(join(resources, file)));
			const digest = hash(JSON.stringify(hashes));
			if (previous?.version === version && previous.digest !== digest)
				throw Error(
					"Browser runtime version has different contents. Publish a new immutable version.",
				);
			const destination = join(root, "runtimes", `${version}-${digest}`);
			await mkdir(join(destination, "runtimes"), { recursive: true, mode: 0o700 });
			await mkdir(join(destination, "helper"), { recursive: true, mode: 0o700 });
			for (const file of files) {
				const target = join(destination, file);
				const existing = await readFile(target).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return undefined;
					throw error;
				});
				if (existing && hash(existing) !== hashes[file])
					throw Error("Installed browser runtime integrity check failed.");
				if (!existing) {
					await copyFile(join(resources, file), target);
					await chmod(target, 0o700);
					if (hash(await readFile(target)) !== hashes[file])
						throw Error("Browser runtime changed during installation.");
				}
			}
			installed = { version, protocol, digest, files: hashes, owners: previous?.owners ?? [] };
		}
		if (!installed) throw Error("Browser runtime unavailable.");
		installed.owners = [...new Set([...installed.owners, client])];
		const assetRoot = join(root, "runtimes", `${installed.version}-${installed.digest}`);
		for (const [file, expected] of Object.entries(installed.files)) {
			if (hash(await readFile(join(assetRoot, file))) !== expected)
				throw Error("Installed browser runtime integrity check failed.");
		}
		// Persist the monotonic version before changing any native registrations. Interrupted
		// registration can be retried, but an older client cannot downgrade this runtime.
		await atomic(join(root, "installation.json"), JSON.stringify(installed), 0o600);
		const executable =
			platform === "win32"
				? join(assetRoot, "runtimes/browser-native-host.exe")
				: join(root, "laplace-browser-host");
		if (platform !== "win32")
			await atomic(
				executable,
				`#!/bin/sh\nexec ${quote(join(assetRoot, "runtimes/node"))} ${quote(join(assetRoot, "helper/browser-native-entry.cjs"))} "$@"\n`,
				0o700,
			);
		for (const directory of directories(home, platform)) {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const path = join(directory, `${browserHostName}.json`);
			await atomic(
				path,
				JSON.stringify({
					name: browserHostName,
					description: "Discover pending Laplace browser connection requests",
					path: executable,
					type: "stdio",
					allowed_origins: [extensionOrigin],
				}),
				0o600,
			);
			if (platform === "win32") await (options.registerWindows ?? registerWindows)(path);
		}
		await atomic(join(root, "installation.json"), JSON.stringify(installed), 0o600);
		return installed;
	});
}
/** Releasing one owner never deletes the shared executable or another client's registration.
 * Retaining the last shared runtime also keeps reconnect/reinstall and recovery safe.
 */
export async function releaseBrowserNativeHost(client: "desktop" | "cli", home = homedir()) {
	const root = join(home, ".laplace", "browser");
	return locked(root, async () => {
		const installed = await readInstallation(root);
		if (!installed) return;
		installed.owners = installed.owners.filter((owner) => owner !== client);
		await atomic(join(root, "installation.json"), JSON.stringify(installed), 0o600);
		return installed;
	});
}
