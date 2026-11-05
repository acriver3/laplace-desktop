import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Assembles the self-contained Laplace Runtime tree shared by Desktop packages and headless
 * archives: bundled runtimes, helper entries, plugin launcher, and the keychain binding.
 */
export async function assembleRuntime(root, destination) {
	const require = createRequire(join(root, "package.json"));
	const keyringRoot = dirname(require.resolve("@napi-rs/keyring/package.json"));
	const nativeName = `@napi-rs/keyring-${process.platform}-${process.arch}${
		process.platform === "win32" ? "-msvc" : process.platform === "linux" ? "-gnu" : ""
	}`;
	const keyringRequire = createRequire(join(keyringRoot, "package.json"));
	const nativeRoot = dirname(keyringRequire.resolve(`${nativeName}/package.json`));
	await rm(destination, { recursive: true, force: true });
	await cp(join(root, "resources"), destination, { recursive: true });
	// Standalone Node cannot read Electron ASAR archives. Keep its complete module
	// tree outside app.asar, including the keychain native binding and stdio bridge.
	await cp(join(root, "dist/update"), join(destination, "update"), { recursive: true });
	await cp(join(root, "dist/helper"), join(destination, "helper"), { recursive: true });
	// Keep the matching plugin launcher beside the helper for candidate installation and rollback.
	await cp(join(root, "../../plugins/laplace"), join(destination, "plugin"), { recursive: true });
	await mkdir(join(destination, "node_modules/@napi-rs"), { recursive: true });
	await cp(keyringRoot, join(destination, "node_modules/@napi-rs/keyring"), {
		recursive: true,
		dereference: true,
	});
	await cp(nativeRoot, join(destination, "node_modules", nativeName), {
		recursive: true,
		dereference: true,
	});
	// Lets a standalone runtime install itself into the stable per-user location.
	const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	await writeFile(join(destination, "VERSION"), version);
	return version;
}
