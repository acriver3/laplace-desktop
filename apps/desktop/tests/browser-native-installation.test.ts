import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerBrowserNativeHost } from "@repo/browser-runtime/browser-native-host";
import {
	installBrowserNativeHost,
	releaseBrowserNativeHost,
} from "@repo/browser-runtime/native-installation";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("gates shared registration, then retains it when a client starts with the flag off", async () => {
	const { home, resources } = await fixture();
	vi.stubEnv("LAPLACE_TETHERED_BROWSER_V1", "true");
	await registerBrowserNativeHost(resources, { home, platform: "darwin" });
	const path = join(home, ".laplace/browser/laplace-browser-host");
	const installed = await readFile(path, "utf8");
	vi.stubEnv("LAPLACE_TETHERED_BROWSER_V1", "false");
	await registerBrowserNativeHost(resources, { home, platform: "darwin" });
	expect(await readFile(path, "utf8")).toBe(installed);
	const manifest = JSON.parse(
		await readFile(
			join(
				home,
				"Library/Application Support/Google/Chrome/NativeMessagingHosts/com.laplace.browser.json",
			),
			"utf8",
		),
	);
	expect(manifest.path).toBe(path);
});
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "laplace-shared-host-"));
	roots.push(home);
	const resources = join(home, "client-resources");
	await mkdir(join(resources, "runtimes"), { recursive: true });
	await mkdir(join(resources, "helper"));
	await writeFile(join(resources, "runtimes/node"), "fixture-node");
	await writeFile(join(resources, "runtimes/node.exe"), "fixture-node-windows");
	await writeFile(join(resources, "runtimes/browser-native-host.exe"), "fixture-launcher");
	await writeFile(join(resources, "helper/browser-native-entry.cjs"), "fixture-entry");
	return { home, resources };
}
it("serializes concurrent clients and survives removal of either supplying installation", async () => {
	const { home, resources } = await fixture();
	await Promise.all([
		installBrowserNativeHost(resources, { home, platform: "darwin", client: "desktop" }),
		installBrowserNativeHost(resources, { home, platform: "darwin", client: "cli" }),
	]);
	const state = JSON.parse(
		await readFile(join(home, ".laplace/browser/installation.json"), "utf8"),
	);
	expect(state.owners.sort()).toEqual(["cli", "desktop"]);
	await rm(resources, { recursive: true });
	expect((await releaseBrowserNativeHost("desktop", home))?.owners).toEqual(["cli"]);
	const executable = await readFile(join(home, ".laplace/browser/laplace-browser-host"), "utf8");
	expect(executable).not.toContain("client-resources");
	expect(
		await readFile(
			join(
				home,
				`.laplace/browser/runtimes/${state.version}-${state.digest}/helper/browser-native-entry.cjs`,
			),
			"utf8",
		),
	).toBe("fixture-entry");
	expect((await releaseBrowserNativeHost("cli", home))?.owners).toEqual([]);
	expect(await readFile(join(home, ".laplace/browser/laplace-browser-host"), "utf8")).toBe(
		executable,
	);
});
it("retains a newer compatible host when an older client registers or its owner is removed", async () => {
	const { home, resources } = await fixture();
	const options = { home, platform: "linux", version: "2.0.0", client: "desktop" as const };
	const newest = await installBrowserNativeHost(resources, options);
	const old = await installBrowserNativeHost("/missing/old/client", {
		...options,
		version: "1.0.0",
		client: "cli",
	});
	expect(old).toMatchObject({
		version: "2.0.0",
		digest: newest.digest,
		owners: ["desktop", "cli"],
	});
	await releaseBrowserNativeHost("desktop", home);
	const retained = JSON.parse(
		await readFile(join(home, ".laplace/browser/installation.json"), "utf8"),
	);
	expect(retained.version).toBe("2.0.0");
	expect(retained.owners).toEqual(["cli"]);
	await expect(installBrowserNativeHost(resources, { ...options, protocol: 2 })).rejects.toThrow(
		"incompatible",
	);
});
it("rejects mutated same-version assets and preserves foreign native registrations", async () => {
	const { home, resources } = await fixture();
	const options = { home, platform: "darwin" };
	await installBrowserNativeHost(resources, options);
	await writeFile(join(resources, "helper/browser-native-entry.cjs"), "changed-entry");
	await expect(installBrowserNativeHost(resources, options)).rejects.toThrow("immutable version");
	const path = join(
		home,
		"Library/Application Support/Google/Chrome/NativeMessagingHosts/com.laplace.browser.json",
	);
	const foreign = JSON.stringify({ name: "foreign", allowed_origins: ["other"] });
	await writeFile(path, foreign);
	await expect(
		installBrowserNativeHost(resources, { ...options, version: "3.0.0" }),
	).rejects.toThrow("unrelated");
	expect(await readFile(path, "utf8")).toBe(foreign);
});
it("registers Windows against a shared copied launcher and recovers an interrupted registration", async () => {
	const { home, resources } = await fixture();
	const registerWindows = vi
		.fn()
		.mockRejectedValueOnce(Error("registry unavailable"))
		.mockResolvedValue(undefined);
	const options = { home, platform: "win32", registerWindows };
	await expect(installBrowserNativeHost(resources, options)).rejects.toThrow(
		"registry unavailable",
	);
	const installed = await installBrowserNativeHost(resources, { ...options, client: "cli" });
	expect(installed.owners).toEqual(["desktop", "cli"]);
	const manifest = JSON.parse(
		await readFile(
			join(home, ".laplace-desktop/native-messaging/com.laplace.browser.json"),
			"utf8",
		),
	);
	expect(manifest.path).toBe(
		join(
			home,
			`.laplace/browser/runtimes/${installed.version}-${installed.digest}/runtimes/browser-native-host.exe`,
		),
	);
	expect(await readFile(manifest.path, "utf8")).toBe("fixture-launcher");
});
