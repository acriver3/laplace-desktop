import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import { browserExtensionId } from "./browser-extension-id";
import { browserHostName, listBrowserRequests } from "./browser-requests";
import { installBrowserNativeHost } from "./native-installation";

export const nativeBrowserOrigin = `chrome-extension://${browserExtensionId}/`;
/** Native messaging is discovery only. It cannot approve access or execute tools. */
export async function runBrowserNativeHost(
	origin: string,
	input: Readable = process.stdin,
	output: Writable = process.stdout,
	directory?: string,
) {
	if (origin !== nativeBrowserOrigin) throw new Error("Unrecognized browser extension.");

	let bytes = Buffer.alloc(0),
		watching = false,
		busy = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const send = async () => {
		if (busy) return;
		busy = true;
		try {
			const payload = Buffer.from(
				JSON.stringify({ requests: await listBrowserRequests(directory) }),
			);
			const header = Buffer.alloc(4);
			header.writeUInt32LE(payload.length);
			await new Promise<void>((resolve, reject) =>
				output.write(Buffer.concat([header, payload]), (error) =>
					error ? reject(error) : resolve(),
				),
			);
		} finally {
			busy = false;
		}
	};
	try {
		for await (const part of input) {
			if (watching) throw Error("Unexpected subscription input.");
			bytes = Buffer.concat([bytes, Buffer.from(part)]);
			if (bytes.length > 4096) throw Error("Native message too large.");
			if (bytes.length < 4) continue;
			const length = bytes.readUInt32LE(0);
			if (length > 4092 || !length) throw Error("Invalid native message.");
			if (bytes.length < length + 4) continue;
			if (bytes.length !== length + 4) throw Error("Unexpected native frames.");
			const request = JSON.parse(bytes.subarray(4).toString("utf8"));
			if (
				!["list_pending", "watch_pending"].includes(request?.method) ||
				Object.keys(request).length !== 1
			)
				throw Error("Unknown native method.");
			await send();
			if (request.method === "list_pending") return;
			watching = true;
			timer = setInterval(() => void send().catch(() => input.destroy()), 750);
		}
	} finally {
		clearInterval(timer);
	}
}

async function registerLegacyBrowserNativeHost(
	resources: string,
	options: {
		home?: string;
		platform?: string;
		registerWindows?: (path: string) => Promise<void>;
	} = {},
) {
	const home = options.home ?? homedir(),
		platform = options.platform ?? process.platform;
	const directories =
		platform === "win32"
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
	for (const directory of directories) {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, `${browserHostName}.json`);
		const previous = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (previous) {
			const value = JSON.parse(previous);
			if (
				value.name !== browserHostName ||
				JSON.stringify(value.allowed_origins) !== JSON.stringify([nativeBrowserOrigin])
			)
				throw new Error("An unrelated native host registration exists.");
		}
		const executable =
			platform === "win32"
				? join(resources, "runtimes", "browser-native-host.exe")
				: join(directory, "laplace-browser-host");
		if (platform !== "win32") {
			const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
			await writeFile(
				executable,
				"#!/bin/sh\nexec " +
					quote(join(resources, "runtimes", "node")) +
					" " +
					quote(join(resources, "helper", "browser-native-entry.cjs")) +
					' "$@"\n',
				{ mode: 0o700 },
			);
		}
		await writeFile(
			path,
			JSON.stringify({
				name: browserHostName,
				description: "Discover pending Laplace browser connection requests",
				path: executable,
				type: "stdio",
				allowed_origins: [nativeBrowserOrigin],
			}),
			{ mode: 0o600 },
		);
		if (platform === "win32") {
			if (options.registerWindows) await options.registerWindows(path);
			else
				for (const browser of ["Google\\Chrome", "Microsoft\\Edge"]) {
					const key = `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${browserHostName}`;
					const existing = await promisify(execFile)("reg.exe", ["query", key, "/ve"], {
						windowsHide: true,
					}).catch(() => null);
					const previousPath = existing?.stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
					if (previousPath && previousPath.toLowerCase() !== path.toLowerCase())
						throw new Error("A different native host registration already exists.");
					await promisify(execFile)(
						"reg.exe",
						["add", key, "/ve", "/t", "REG_SZ", "/d", path, "/f"],
						{ windowsHide: true },
					);
				}
		}
	}
}

/** Shared registration is opt-in until platform acceptance, then remains monotonic. */
export async function registerBrowserNativeHost(
	resources: string,
	options: {
		home?: string;
		platform?: string;
		registerWindows?: (path: string) => Promise<void>;
	} = {},
) {
	const shared = await readFile(
		join(options.home ?? homedir(), ".laplace", "browser", "installation.json"),
		"utf8",
	).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (process.env.LAPLACE_TETHERED_BROWSER_V1 === "true" || shared) {
		await installBrowserNativeHost(resources, { ...options, client: "desktop" });
	} else await registerLegacyBrowserNativeHost(resources, options);
}
