import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { currentRuntime, installRuntime, selectRuntime } from "../src/install";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});
async function source(version: string) {
	const directory = await mkdtemp(join(tmpdir(), "runtime-source-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, "helper"), { recursive: true });
	await writeFile(join(directory, "helper", "service.cjs"), `// ${version}`);
	await writeFile(join(directory, "VERSION"), version);
	return directory;
}

it("installs versions beside each other and keeps the previous one for rollback", async () => {
	const home = await mkdtemp(join(tmpdir(), "runtime-home-"));
	cleanup.push(() => rm(home, { recursive: true, force: true }));
	const first = await installRuntime(await source("0.1.1"), "0.1.1", { home });
	expect(first.service).toBe(join(home, "versions", "0.1.1", "helper", "service.cjs"));
	const launcher = await readFile(first.launcher, "utf8");
	expect(launcher).toContain(process.platform === "win32"
		? "versions\\%version%\\helper\\launcher.cjs"
		: "versions/$version/helper/launcher.cjs");
	if (process.platform !== "win32") expect((await stat(first.launcher)).mode & 0o100).toBeTruthy();

	// Reinstalling the same version reuses the completed tree.
	await installRuntime(await source("changed"), "0.1.1", { home });
	expect(await readFile(first.service, "utf8")).toBe("// 0.1.1");

	await installRuntime(await source("0.1.2"), "0.1.2", { home });
	await installRuntime(await source("0.1.3"), "0.1.3", { home });
	expect((await currentRuntime(home))?.version).toBe("0.1.3");
	expect((await readdir(join(home, "versions"))).sort()).toEqual(["0.1.2", "0.1.3"]);
	expect(await selectRuntime("0.1.2", home)).toBe("0.1.3");
	expect((await currentRuntime(home))?.version).toBe("0.1.2");
	await expect(selectRuntime("0.1.1", home)).rejects.toThrow("not installed");
});
