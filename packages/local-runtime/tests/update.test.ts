import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import { controlRequest, readRuntimeDescriptor } from "../src/control";
import { currentRuntime, installRuntime, runtimeLayout } from "../src/install";
import { startRuntime, stopRuntime } from "../src/lifecycle";
import { swapRunningRuntime } from "../src/update";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});
async function tree(version: string, behavior = "ok") {
	const directory = await mkdtemp(join(tmpdir(), "runtime-version-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, "helper"), { recursive: true });
	await mkdir(join(directory, "runtimes"), { recursive: true });
	await copyFile(
		resolve("tests/fixtures/versioned-service.cjs"),
		join(directory, "helper", "service.cjs"),
	);
	await symlink(process.execPath, join(directory, "runtimes", "node"));
	await writeFile(join(directory, "VERSION"), version);
	await writeFile(join(directory, "BEHAVIOR"), behavior);
	return directory;
}
async function fixture(behavior = "ok") {
	const home = await mkdtemp(join(tmpdir(), "runtime-home-"));
	const root = await mkdtemp(join(tmpdir(), "runtime-profile-"));
	cleanup.push(() => rm(home, { recursive: true, force: true }));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	cleanup.push(() => stopRuntime(root, 3000).catch(() => {}));
	const first = await installRuntime(await tree("1.0.0", behavior), "1.0.0", { home });
	await startRuntime({
		root,
		...runtimeLayout(first.directory),
		resources: first.directory,
		origin: "https://connect.fixture.invalid",
		explicit: true,
	});
	return { home, root };
}
const version = async (root: string) =>
	(
		await controlRequest<{ version: string }>(
			(await readRuntimeDescriptor(root))!,
			"runtime.info",
		)
	).version;

it.skipIf(process.platform === "win32")(
	"drains the running runtime, moves it to the selected version, and verifies it",
	async () => {
		const { home, root } = await fixture();
		expect(await version(root)).toBe("1.0.0");
		expect(await swapRunningRuntime({ root, origin: "https://x.invalid", home })).toEqual({
			swapped: false,
			reason: "current",
		});
		await installRuntime(await tree("1.1.0"), "1.1.0", { home });
		expect(await swapRunningRuntime({ root, origin: "https://x.invalid", home })).toEqual({
			swapped: true,
			from: "1.0.0",
			to: "1.1.0",
		});
		expect(await version(root)).toBe("1.1.0");
	},
);

it.skipIf(process.platform === "win32")(
	"restores the previous version when the new one fails to start",
	async () => {
		const { home, root } = await fixture();
		await installRuntime(await tree("2.0.0", "crash"), "2.0.0", { home });
		const result = await swapRunningRuntime({ root, origin: "https://x.invalid", home });
		expect(result).toMatchObject({
			swapped: false,
			reason: "restored",
			from: "1.0.0",
			to: "2.0.0",
		});
		expect((await currentRuntime(home))?.version).toBe("1.0.0");
		expect(await version(root)).toBe("1.0.0");
	},
);

it.skipIf(process.platform === "win32")(
	"defers without stopping anything while the running runtime stays busy",
	async () => {
		const { home, root } = await fixture("busy");
		await installRuntime(await tree("1.1.0"), "1.1.0", { home });
		const result = await swapRunningRuntime({
			root,
			origin: "https://x.invalid",
			home,
			drainTimeout: 300,
			pollInterval: 50,
		});
		expect(result).toEqual({ swapped: false, reason: "busy" });
		expect(await version(root)).toBe("1.0.0");
	},
);

it.skipIf(process.platform === "win32")(
	"hands the maintenance lease back when the old runtime does not exit",
	async () => {
		const { home, root } = await fixture("stubborn");
		cleanup.push(async () => {
			const descriptor = await readRuntimeDescriptor(root);
			if (descriptor) process.kill(descriptor.pid, "SIGKILL");
		});
		await installRuntime(await tree("1.1.0"), "1.1.0", { home });
		const result = await swapRunningRuntime({
			root,
			origin: "https://x.invalid",
			home,
			stopTimeout: 300,
		});
		expect(result).toEqual({ swapped: false, reason: "not-stopped" });
		const descriptor = (await readRuntimeDescriptor(root))!;
		expect(await version(root)).toBe("1.0.0");
		// The lease was released, so a later attempt can acquire it again.
		expect(await controlRequest<boolean>(descriptor, "updates.acquire")).toBe(true);
	},
);
