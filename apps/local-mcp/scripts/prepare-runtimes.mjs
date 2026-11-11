import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
	cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertWindowsBuildTools } from "./windows-prerequisites.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const catalog = JSON.parse(await readFile(join(root, "resources/runtime-catalog.json"), "utf8"));
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const platform = catalog.platforms[target];
const windows = target.startsWith("win32-");
if (!platform)
	throw new Error("Build runtime bundles on Windows x64, macOS x64/arm64 or Linux x64");
const compilerEnvironment = windows && process.platform === "win32" ? assertWindowsBuildTools() : undefined;
const destination = process.argv[3] ? resolve(process.argv[3]) : join(root, "resources/runtimes");
await mkdir(destination, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "laplace-runtimes-"));
async function archive(name, asset) {
	const response = await fetch(asset.url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error(`Download failed: ${name}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
		throw new Error(`Checksum mismatch: ${name}`);
	const file = join(temporary, name + (asset.url.endsWith("zip") ? ".zip" : ".tar.gz"));
	await writeFile(file, bytes);
	const directory = join(temporary, name);
	await mkdir(directory);
	if (file.endsWith("zip")) {
		// Build-time extraction only, with verified pinned input and script arguments.
		if (process.platform === "win32")
			execFileSync("tar.exe", ["-xf", file, "-C", directory], { stdio: "inherit" });
		else execFileSync("python3", ["-m", "zipfile", "-e", file, directory], { stdio: "inherit" });
	} else execFileSync("tar", ["-xzf", file, "-C", directory], { stdio: "inherit" });
	return directory;
}
async function find(directory, name) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isFile() && entry.name === name) return file;
		if (entry.isDirectory()) {
			const found = await find(file, name);
			if (found) return found;
		}
	}
}
try {
	for (const name of ["node", "uv"]) {
		const directory = await archive(name, platform[name]);
		const binary = `${name}${windows ? ".exe" : ""}`;
		const source = await find(directory, binary);
		if (!source) throw new Error(`Missing runtime: ${binary}`);
		if (name === "node") {
			const npx = await find(directory, "npx-cli.js");
			if (!npx) throw new Error("Bundled npm is missing");
			await cp(dirname(dirname(npx)), join(destination, "npm"), { recursive: true });
		}
		await copyFile(source, join(destination, binary));
		if (process.platform !== "win32") await chmod(join(destination, binary), 0o755);
		for (const license of ["LICENSE", "LICENSE-MIT", "LICENSE-APACHE"]) {
			const file = await find(directory, license);
			if (file) await copyFile(file, join(destination, `${name}-${license}`));
		}
	}
	await copyFile(
		join(root, "resources/runtime-catalog.json"),
		join(destination, "runtime-catalog.json"),
	);
	if (windows && process.platform === "win32") {
		for (const source of ["process-host"])
			execFileSync(
				"cl.exe",
				[
					"/nologo",
					"/O2",
					"/MT",
					"/DUNICODE",
					"/D_UNICODE",
					join(root, `native/${source}.c`),
					`/Fe:${resolve(destination, `${source}.exe`)}`,
					"shell32.lib",
					"advapi32.lib",
				],
				{ cwd: temporary, stdio: "inherit", env: compilerEnvironment, windowsHide: true },
			);
	}
	if (windows && process.platform !== "win32") {
		const helper = process.argv[4];
		if (!helper)
			throw new Error("Cross packaging Windows requires an explicitly compiled process-host.exe");
		await copyFile(resolve(helper), join(destination, "process-host.exe"));
	}
} finally {
	await rm(temporary, { recursive: true, force: true });
}
