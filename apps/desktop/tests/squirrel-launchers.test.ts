import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it, expect } from "vitest";

import { preserveSquirrelLaunchers } from "../src/update/installer";
it("preserves historical assistant paths using the packaged runtime directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "squirrel-launcher-"));
	try {
		const backup = join(root, "backup"),
			directory = join(root, "Laplace"),
			destination = join(directory, "app-1.1.0");
		await mkdir(join(backup, "app-1.0.0"), { recursive: true });
		await mkdir(join(destination, "resources/runtime/runtimes"), { recursive: true });
		await writeFile(join(destination, "resources/runtime/runtimes/node.exe"), "node fixture");
		await preserveSquirrelLaunchers(directory, backup, destination);
		const old = join(directory, "app-1.0.0/resources/runtime");
		expect(await readFile(join(old, "runtimes/node.exe"), "utf8")).toBe("node fixture");
		expect(await readFile(join(old, "helper/bridge.cjs"), "utf8")).toContain(
			JSON.stringify(join(destination, "resources/runtime/helper/bridge.cjs")),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
