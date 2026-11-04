import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2).filter((argument) => argument !== "--refresh");
const target = args[0] ?? `${process.platform}-${process.arch}`;
const destination = resolve(args[1] ?? resolve(root, "resources/runtimes"));
const windows = target.startsWith("win32-");
const sourceCatalog = readFileSync(resolve(root, "../local-mcp/resources/runtime-catalog.json"));
const catalog = JSON.parse(sourceCatalog);
if (!catalog.platforms[target]) throw new Error(`Unsupported desktop runtime target: ${target}`);
const receiptFile = resolve(destination, ".laplace-runtime-target.json");
const receipt = JSON.stringify({
	target,
	catalog: createHash("sha256").update(sourceCatalog).digest("hex"),
	...(windows
		? {
				processHost: createHash("sha256")
					.update(readFileSync(resolve(root, "../local-mcp/native/process-host.c")))
					.digest("hex"),
			}
		: {}),
});
const node = resolve(destination, windows ? "node.exe" : "node");
const uv = resolve(destination, windows ? "uv.exe" : "uv");
function complete() {
	try {
		const required = [
			node,
			uv,
			resolve(destination, "npm/bin/npm-cli.js"),
			resolve(destination, "npm/bin/npx-cli.js"),
			...(windows ? [resolve(destination, "process-host.exe")] : []),
		];
		if (
			!required.every(existsSync) ||
			!readFileSync(resolve(destination, "runtime-catalog.json")).equals(sourceCatalog)
		)
			return false;
		if (existsSync(receiptFile)) return readFileSync(receiptFile, "utf8") === receipt;
		// Adopt an existing verified native cache only after checking its actual
		// architecture and versions. A Windows helper without a source receipt
		// must be rebuilt so a stale or partially prepared Job Object host is not used.
		if (windows || target !== `${process.platform}-${process.arch}`) return false;
		const actual = execFileSync(
			node,
			[
				"-p",
				"JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})",
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		const info = JSON.parse(actual);
		return (
			`${info.platform}-${info.arch}` === target &&
			info.version === catalog.nodeVersion &&
			execFileSync(uv, ["--version"], { encoding: "utf8", timeout: 10000 })
				.trim()
				.split(/\s+/)[1] === catalog.uvVersion
		);
	} catch {
		return false;
	}
}
if (!complete() || process.argv.includes("--refresh")) {
	execFileSync(
		process.execPath,
		[resolve(root, "../local-mcp/scripts/prepare-runtimes.mjs"), target, destination],
		{ stdio: "inherit" },
	);
}
writeFileSync(receiptFile, receipt);
if (
	["win32", "darwin"].includes(process.platform) &&
	target === `${process.platform}-${process.arch}`
)
	await import("./point-native.mjs");
cpSync(resolve(root, "runtime-manifests/bitwarden"), resolve(destination, "../bitwarden"), {
	recursive: true,
});
