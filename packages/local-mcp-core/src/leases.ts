import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ServerConfig } from "./config";

async function canonical(path: string): Promise<string> {
	const absolute = resolve(path);
	let value: string;
	try {
		value = await realpath(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(absolute);
		value =
			parent === absolute
				? absolute
				: join(await canonical(parent), absolute.slice(parent.length + 1));
	}
	return process.platform === "win32" ? value.toLowerCase() : value;
}
/** The Outlook catalog connector, installed from npm or from a legacy bundle. */
export const outlookIdentity = (identity?: string) =>
	!!identity &&
	(identity.startsWith("msoutlook-mcp@") || identity.startsWith("npm:@withlaplace/msoutlook-mcp@"));
async function resources(config: ServerConfig, cwd: string) {
	if (config.transport !== "stdio") return [];
	const paths = [cwd];
	for (let index = 0; index < config.args.length; index++) {
		const arg = config.args[index]!;
		if (
			/^--(?:profile-dir|user-data-dir|session-dir|data-dir|config-dir)$/.test(arg) &&
			config.args[index + 1]
		)
			paths.push(resolve(cwd, config.args[++index]!));
		const match = arg.match(
			/^--(?:profile-dir|user-data-dir|session-dir|data-dir|config-dir)=(.+)$/,
		);
		if (match) paths.push(resolve(cwd, match[1]!));
	}
	for (const [name, value] of Object.entries(config.env))
		if (
			/(?:PROFILE_DIR|SESSION_DIR|USER_DATA_DIR|MCP_HOME|DATA_DIR)$/.test(name) &&
			isAbsolute(value)
		)
			paths.push(value);
	if (outlookIdentity(config.identity))
		paths.push(
			process.platform === "win32"
				? join(process.env.APPDATA ?? homedir(), "msoutlook-mcp-server")
				: join(homedir(), ".msoutlook-mcp-server"),
		);
	return [...new Set(await Promise.all(paths.map(canonical)))].sort();
}
/** Shared across desktop and CLI roots; only the owning process releases a lease. */
export async function acquireResourceLeases(config: ServerConfig, cwd: string) {
	const paths = await resources(config, cwd);
	const root = join(
		tmpdir(),
		`laplace-mcp-leases-${typeof process.getuid === "function" ? process.getuid() : createHash("sha256").update(homedir()).digest("hex").slice(0, 16)}`,
	);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const info = await lstat(root);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())
	)
		throw new Error("Unsafe local process lease directory");
	const nonce = randomUUID(),
		owned: string[] = [];
	const release = async () => {
		for (const path of owned.splice(0).reverse()) {
			try {
				const record = JSON.parse(await readFile(path, "utf8"));
				if (record.pid === process.pid && record.nonce === nonce) await rm(path, { force: true });
			} catch {}
		}
	};
	try {
		for (const resource of paths) {
			const path = join(root, `${createHash("sha256").update(resource).digest("hex")}.json`);
			let acquired = false;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const handle = await open(path, "wx", 0o600);
					owned.push(path);
					try {
						await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
					} finally {
						await handle.close();
					}
					acquired = true;
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					let owner: { pid: number };
					try {
						owner = JSON.parse(await readFile(path, "utf8"));
					} catch {
						// The owner creates the file before writing it; give that write a moment.
						if (attempt < 2) {
							await new Promise((accept) => setTimeout(accept, 100));
							continue;
						}
						throw new Error(
							"Another connector is acquiring this working directory or browser profile. Retry shortly.",
						);
					}
					if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
						throw new Error(
							"Invalid connector resource lease; inspect local processes before retrying",
						);
					try {
						process.kill(owner.pid, 0);
					} catch (cause) {
						if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
							await rm(path, { force: true });
							continue;
						}
						throw cause;
					}
					throw new Error(
						"Another Laplace process owns this connector's working directory or browser profile. Stop it before starting here.",
					);
				}
			}
			if (!acquired) throw new Error("Connector resource lease unavailable");
		}
		return release;
	} catch (error) {
		await release();
		throw error;
	}
}
