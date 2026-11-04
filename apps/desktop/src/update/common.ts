import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	access,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	readlink,
	realpath,
	rename,
	rm,
	statfs,
} from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { z } from "zod";

export const repository = "https://github.com/acriver3/laplace-desktop.git";
const legacyRepository = "https://github.com/acriver3/Laplace.git";
export const protocolVersion = 1;
export const versionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const targetSchema = z.enum(["darwin-arm64", "darwin-x64", "win32-x64"]);
export const installationSchema = z
	.object({
		protocol: z.literal(protocolVersion),
		id: z.string().uuid(),
		owner: z.string().min(1),
		// The previous installer preserves its metadata when it accepts an update.
		// Network requests always use the compiled-in public repository.
		repository: z.enum([repository, legacyRepository]),
		target: targetSchema,
		path: z.string().refine(isAbsolute),
		version: versionSchema,
		commit: revisionSchema,
		git: z.string().refine(isAbsolute),
		node: z.string().refine(isAbsolute),
		pnpm: z.string().refine(isAbsolute),
		toolPath: z.string().min(1).max(32768),
	})
	.strict();
export type Installation = z.infer<typeof installationSchema>;
export interface Release {
	version: string;
	commit: string;
}
export const updateRoot = () => join(homedir(), ".laplace-desktop-updates");
export const nativeTarget = () => targetSchema.parse(`${process.platform}-${process.arch}`);
export const defaultDestination = () =>
	process.platform === "darwin"
		? join(homedir(), "Applications", "Laplace.app")
		: join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LaplaceSource", "app");
export const executable = (path: string, target: string) =>
	join(
		path,
		...(target.startsWith("darwin-") ? ["Contents", "MacOS", "Laplace"] : ["Laplace.exe"]),
	);
export const runtimePath = (path: string, target: string) =>
	join(
		path,
		...(target.startsWith("darwin-")
			? ["Contents", "Resources", "runtime"]
			: ["resources", "runtime"]),
	);

export function assertDestination(path: string) {
	if (
		path !== defaultDestination() &&
		!(process.platform === "darwin" && path === "/Applications/Laplace.app")
	)
		throw new Error(
			"Use the managed installation location, or explicitly adopt /Applications/Laplace.app.",
		);
}
export async function exists(path: string) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
export async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}
export async function writeJson(path: string, data: unknown) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(JSON.stringify(data, null, 2) + "\n");
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
}
export async function readInstallation(root = updateRoot()) {
	const value = installationSchema.parse(await readJson(join(root, "installation.json")));
	if (value.owner !== userInfo().username || value.target !== nativeTarget())
		throw new Error("This installation belongs to another user or platform.");
	assertDestination(value.path);
	if ((await lstat(root)).isSymbolicLink() || (await lstat(value.path)).isSymbolicLink())
		throw new Error("Managed installation paths must not be symbolic links.");
	return value;
}
export function newer(a: string, b: string) {
	const left = versionSchema.parse(a).split(".").map(BigInt),
		right = versionSchema.parse(b).split(".").map(BigInt);
	for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
	return false;
}
export function selectRelease(output: string, current: string): Release | undefined {
	const tags = new Map<string, string>();
	for (const line of output.trim().split("\n")) {
		const match =
			/^([a-f0-9]{40})\s+refs\/tags\/desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(\^\{\})?$/.exec(
				line,
			);
		if (match && (match[3] || !tags.has(match[2]!))) tags.set(match[2]!, match[1]!);
	}
	return [...tags]
		.filter(([version]) => newer(version, current))
		.sort(([a], [b]) => (newer(a, b) ? -1 : 1))
		.map(([version, commit]) => ({ version, commit }))[0];
}

/** Only explicitly selected user environment reaches tools. Never inherit app secrets. */
export function toolEnvironment(authentication = false): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"PATH",
		"Path",
		"HOME",
		"USERPROFILE",
		"LOCALAPPDATA",
		"APPDATA",
		"SystemRoot",
		"WINDIR",
		"TEMP",
		"TMP",
		"TMPDIR",
		"LANG",
		"SHELL",
	])
		if (process.env[key]) env[key] = process.env[key];
	if (authentication && process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
	return { ...env, CI: "true", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
}
export class UpdateError extends Error {
	constructor(
		public code: "tools" | "network" | "build" | "disk" | "cancelled" | "install" | "invalid",
		message: string,
	) {
		super(message);
	}
}
export async function run(
	command: string,
	args: string[],
	options: {
		cwd?: string;
		signal?: AbortSignal;
		authentication?: boolean;
		timeout?: number;
		message?: string;
		toolPath?: string;
		home?: string;
	} = {},
): Promise<string> {
	if (options.signal?.aborted) throw new UpdateError("cancelled", "Update cancelled.");
	return new Promise((done, fail) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: {
				...toolEnvironment(options.authentication),
				...(options.toolPath ? { PATH: options.toolPath } : {}),
				...(options.home ? { HOME: options.home } : {}),
			},
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "",
			cancelled = false,
			expired = false;
		// Subprocess output can include credentials. Only successful bounded stdout is returned.
		child.stdout.on("data", (data: Buffer) => {
			if (output.length < 2_000_000) output += data.toString();
		});
		child.stderr.resume();
		const stop = () => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				const killer = spawn(
					join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
					["/pid", String(child.pid), "/t", "/f"],
					{ windowsHide: true, stdio: "ignore" },
				);
				killer.on("error", () => child.kill());
			} else {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			}
		};
		const abort = () => {
			cancelled = true;
			stop();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			expired = true;
			stop();
		}, options.timeout ?? 60_000);
		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		};
		child.once("error", () => {
			cleanup();
			fail(
				new UpdateError(
					"tools",
					"A required build tool could not start. Run the source installation setup again.",
				),
			);
		});
		child.once("close", (code) => {
			cleanup();
			if (cancelled) fail(new UpdateError("cancelled", "Update cancelled."));
			else if (code !== 0 || expired)
				fail(
					new UpdateError(
						options.authentication ? "network" : "build",
						options.message ??
							(options.authentication
								? "GitHub could not be reached or repository access expired. Check your network and Git credentials, then retry."
								: "The update build failed or timed out. The current installation has not changed."),
					),
				);
			else done(output.trim());
		});
	});
}
export async function requireSpace(path: string) {
	const disk = await statfs(path);
	if (disk.bavail * disk.bsize < 6 * 1024 ** 3)
		throw new UpdateError("disk", "At least 6 GB of free space is required to build an update.");
}
export async function packageDigest(path: string): Promise<string> {
	const root = await realpath(path),
		hash = createHash("sha256");
	async function visit(directory: string) {
		for (const entry of (await readdir(directory)).sort()) {
			const file = join(directory, entry),
				info = await lstat(file);
			hash.update(JSON.stringify([relative(root, file), info.mode & 0o777]));
			if (info.isSymbolicLink()) {
				const target = await realpath(file);
				if (target !== root && !target.startsWith(root + sep))
					throw new Error("Package contains an escaping symlink.");
				hash.update(await readlink(file));
			} else if (info.isDirectory()) await visit(file);
			else if (info.isFile()) {
				const handle = await open(file, "r");
				try {
					for await (const chunk of handle.createReadStream()) hash.update(chunk);
				} finally {
					await handle.close();
				}
			} else throw new Error("Package contains an unsupported file.");
		}
	}
	await visit(root);
	return hash.digest("hex");
}
export async function lock(root: string): Promise<() => Promise<void>> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const path = join(root, "lock");
	try {
		await mkdir(path);
	} catch {
		let pid: number;
		try {
			pid = z
				.number()
				.int()
				.positive()
				.parse(await readJson(join(path, "pid.json")));
		} catch {
			throw new Error("An update lock needs recovery. Retry shortly or run source setup recovery.");
		}
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				await rm(path, { recursive: true });
				return lock(root);
			}
		}
		throw new Error("Another Desktop update is already running.");
	}
	await writeJson(join(path, "pid.json"), process.pid);
	return () => rm(path, { recursive: true, force: true });
}
export async function validateTools(
	installation: Pick<Installation, "git" | "node" | "pnpm" | "toolPath">,
) {
	await run(installation.git, ["--version"], { toolPath: installation.toolPath });
	const node = await run(installation.node, ["--version"], { toolPath: installation.toolPath });
	if (!/^v24\./.test(node))
		throw new UpdateError(
			"tools",
			"Source updates require Node 24. Run source setup with Node 24.",
		);
	const pnpm = await run(installation.node, [installation.pnpm, "--version"], {
		toolPath: installation.toolPath,
	});
	if (pnpm !== "10.28.2")
		throw new UpdateError(
			"tools",
			"Source updates require pnpm 10.28.2. Run source setup again after installing it.",
		);
}
export async function resolveTool(name: string) {
	for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(
		process.platform === "win32" ? ";" : ":",
	)) {
		const path = join(directory, name + (process.platform === "win32" ? ".exe" : ""));
		if (await exists(path)) return realpath(path);
	}
	throw new Error(`Install ${name} and add it to PATH before running source setup.`);
}
export async function resolvePnpm() {
	for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(
		process.platform === "win32" ? ";" : ":",
	)) {
		for (const path of [
			join(directory, "pnpm"),
			join(directory, "node_modules/pnpm/bin/pnpm.cjs"),
			join(directory, "node_modules/corepack/dist/pnpm.js"),
		]) {
			if (await exists(path)) {
				const full = await realpath(path);
				if (/\.(c?js)$/.test(basename(full))) return full;
			}
		}
	}
	throw new Error(
		"Install the JavaScript pnpm 10.28.2 distribution (npm install -g pnpm@10.28.2), then retry.",
	);
}

export async function requireAppClosed(path: string, target: string) {
	if (process.platform === "darwin") {
		const processes = await run("/bin/ps", ["-axo", "comm="]);
		if (processes.split("\n").some((line) => line.trim() === executable(path, target)))
			throw new Error("Quit this Laplace installation before running source setup or recovery.");
	} else {
		const processes = await run(
			join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"),
			["/FI", "IMAGENAME eq Laplace.exe", "/FO", "CSV", "/NH"],
		);
		if (/"Laplace\.exe"/i.test(processes))
			throw new Error("Quit Laplace before running source setup or recovery.");
	}
}

/** Existing AI clients must not race the installer by relaunching the old app. */
export async function updateLaunchBlocked(application: string, root = updateRoot()) {
	try {
		const marker = z
			.object({ pid: z.number().int().positive(), executable: z.string() })
			.strict()
			.parse(await readJson(join(root, "installing.json")));
		if (marker.executable !== application) return false;
		process.kill(marker.pid, 0);
		return true;
	} catch {
		return false;
	}
}
