import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
export async function verifyBrowserRuntime(root = fileURLToPath(new URL("..", import.meta.url))) {
	const lock = JSON.parse(await readFile(resolve(root, "source-lock.json"), "utf8"));
	if (
		!/^[a-f0-9]{40}$/.test(lock.revision) ||
		lock.repository !== "https://github.com/acriver3/laplace-mcp-library"
	)
		throw Error("Invalid browser runtime source pin");
	const paths = [];
	async function walk(directory) {
		for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
			const path = `${directory}/${entry.name}`;
			if (entry.isSymbolicLink()) throw Error("Browser runtime source must not contain symlinks");
			if (entry.isDirectory()) await walk(path);
			else paths.push(path);
		}
	}
	await walk("src");
	await walk("extension");
	await walk("assets");
	if (JSON.stringify(paths.sort()) !== JSON.stringify(Object.keys(lock.files).sort()))
		throw Error("Browser runtime file inventory changed");
	for (const path of paths) {
		const absolute = resolve(root, path);
		if (relative(root, absolute).startsWith("..")) throw Error("Invalid runtime path");
		const actual = createHash("sha256")
			.update(await readFile(absolute))
			.digest("hex");
		if (actual !== lock.files[path]) throw Error(`Browser runtime source mismatch: ${path}`);
	}
	return { revision: lock.revision, files: paths.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	console.log(JSON.stringify(await verifyBrowserRuntime()));
