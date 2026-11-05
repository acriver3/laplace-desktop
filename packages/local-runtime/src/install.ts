import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { runtimeHome } from "./paths";

const execute = promisify(execFile);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const exe = (platform = process.platform) => (platform === "win32" ? ".exe" : "");

export function runtimeLayout(directory: string, platform = process.platform) {
	return {
		directory,
		node: join(directory, "runtimes", `node${exe(platform)}`),
		service: join(directory, "helper", "service.cjs"),
		bridge: join(directory, "helper", "bridge.cjs"),
		launcher: join(directory, "helper", "launcher.cjs"),
	};
}
/** Stable entry points that survive runtime updates and Desktop moves. */
export function stableLaunchers(home = runtimeHome(), platform = process.platform) {
	const bin = join(home, "bin");
	return {
		bin,
		launcher: join(bin, platform === "win32" ? "laplace-runtime.cmd" : "laplace-runtime"),
		hidden: join(bin, "laplace-runtime-hidden.exe"),
	};
}

const shellLauncher = `#!/bin/sh
home="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
version="$(cat "$home/current")" || exit 1
exec "$home/versions/$version/runtimes/node" "$home/versions/$version/helper/launcher.cjs" "$@"
`;
const cmdLauncher = `@echo off\r
setlocal\r
set "home=%~dp0.."\r
set /p version=<"%home%\\current"\r
"%home%\\versions\\%version%\\runtimes\\node.exe" "%home%\\versions\\%version%\\helper\\launcher.cjs" %*\r
`;

async function exists(path: string) {
	return stat(path).then(
		() => true,
		() => false,
	);
}
export async function currentVersion(home = runtimeHome()) {
	try {
		return versionSchema.parse((await readFile(join(home, "current"), "utf8")).trim());
	} catch {
		return undefined;
	}
}
export async function currentRuntime(home = runtimeHome()) {
	const version = await currentVersion(home);
	if (!version) return undefined;
	const directory = join(home, "versions", version);
	if (!(await exists(join(directory, ".complete")))) return undefined;
	return { version, ...runtimeLayout(directory) };
}
async function writeAtomic(path: string, data: string, mode = 0o600) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, data, { mode, flag: "wx" });
	await rename(temporary, path);
}
/** Selects an installed version; the previous selection is kept for rollback. */
export async function selectRuntime(version: string, home = runtimeHome()) {
	versionSchema.parse(version);
	if (!(await exists(join(home, "versions", version, ".complete"))))
		throw new Error("Runtime version is not installed");
	const previous = await currentVersion(home);
	if (previous && previous !== version) await writeAtomic(join(home, "previous"), previous);
	await writeAtomic(join(home, "current"), version);
	return previous;
}
/**
 * Copies a complete runtime tree (Desktop's Resources/runtime or a headless archive) into
 * versions/<version>, then points the stable launchers at it. Existing versions are reused.
 */
export async function installRuntime(
	source: string,
	version: string,
	options: { home?: string; select?: boolean; platform?: NodeJS.Platform } = {},
) {
	versionSchema.parse(version);
	const home = options.home ?? runtimeHome();
	const platform = options.platform ?? process.platform;
	const versions = join(home, "versions");
	const target = join(versions, version);
	await mkdir(versions, { recursive: true, mode: 0o700 });
	if (!(await exists(join(target, ".complete")))) {
		const staging = join(versions, `.${version}-${randomUUID()}`);
		try {
			await cp(source, staging, { recursive: true, verbatimSymlinks: true });
			if (platform === "darwin")
				await execute("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staging]).catch(() => {});
			await writeFile(join(staging, ".complete"), version, { mode: 0o600 });
			await rm(target, { recursive: true, force: true });
			await rename(staging, target);
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			// A concurrent installer may have completed the same version first.
			if (!(await exists(join(target, ".complete")))) throw error;
		}
	}
	const { bin, launcher, hidden } = stableLaunchers(home, platform);
	await mkdir(bin, { recursive: true, mode: 0o700 });
	const script = platform === "win32" ? cmdLauncher : shellLauncher;
	if ((await readFile(launcher, "utf8").catch(() => "")) !== script) {
		await writeAtomic(launcher, script, 0o700);
		await chmod(launcher, 0o700);
	}
	const hiddenSource = join(target, "runtimes", "laplace-runtime-hidden.exe");
	if (platform === "win32" && (await exists(hiddenSource)))
		await cp(hiddenSource, hidden).catch(() => {
			/* A running copy keeps working; it only resolves `current`. */
		});
	if (options.select !== false) await selectRuntime(version, home);
	await prune(home);
	return { version, ...runtimeLayout(target, platform), launcher };
}
/** Keeps the selected and previous versions; older complete versions are removed. */
async function prune(home: string) {
	const keep = new Set(
		[await currentVersion(home), await readFile(join(home, "previous"), "utf8").catch(() => "")]
			.filter(Boolean)
			.map((value) => value!.trim()),
	);
	for (const name of await readdir(join(home, "versions")).catch(() => [])) {
		if (keep.has(name)) continue;
		if (name.startsWith(".")) {
			const age = Date.now() - (await stat(join(home, "versions", name))).mtimeMs;
			if (age < 3_600_000) continue;
		}
		await rm(join(home, "versions", name), { recursive: true, force: true }).catch(() => {});
	}
}
