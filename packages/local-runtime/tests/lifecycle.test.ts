import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import { readRuntimeDescriptor } from "../src/control";
import {
	RuntimeStoppedError,
	explicitlyStopped,
	launchAgent,
	startRuntime,
	stopRuntime,
	systemdUnit,
	windowsRunCommand,
} from "../src/lifecycle";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "runtime-lifecycle-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	cleanup.push(() => stopRuntime(root, 2000).catch(() => {}));
	const options = {
		root,
		node: process.execPath,
		service: resolve("tests/fixtures/fake-service.mjs"),
		resources: root,
		origin: "https://connect.fixture.invalid",
		timeout: 10_000,
	};
	return { root, options };
}

it("starts exactly one owner when Desktop, the CLI, and a bridge race", async () => {
	const { root, options } = await fixture();
	const results = await Promise.all([
		startRuntime({ ...options, explicit: true }),
		startRuntime({ ...options, explicit: true }),
		startRuntime(options),
	]);
	expect(new Set(results.map((descriptor) => descriptor.pid)).size).toBe(1);
	expect((await readdir(root)).filter((name) => name.startsWith("started-"))).toHaveLength(1);
});

it("keeps an explicit stop until a user start, and bridges respect it", async () => {
	const { root, options } = await fixture();
	const first = await startRuntime({ ...options, explicit: true });
	expect(await stopRuntime(root, 5000)).toBe(true);
	expect(() => process.kill(first.pid, 0)).toThrow();
	expect(await readRuntimeDescriptor(root)).toBeUndefined();
	expect(await explicitlyStopped(root)).toBe(true);
	await expect(startRuntime(options)).rejects.toBeInstanceOf(RuntimeStoppedError);
	const second = await startRuntime({ ...options, explicit: true });
	expect(second.pid).not.toBe(first.pid);
	expect(await explicitlyStopped(root)).toBe(false);
});

it("does not respawn after the runtime is terminated externally", async () => {
	const { root, options } = await fixture();
	const descriptor = await startRuntime({ ...options, explicit: true });
	process.kill(descriptor.pid, "SIGTERM");
	await expect.poll(() => readRuntimeDescriptor(root)).toBeUndefined();
	await new Promise((accept) => setTimeout(accept, 500));
	expect(await readRuntimeDescriptor(root)).toBeUndefined();
});

it("registers login starts without keep-alive or respawn", () => {
	const plist = launchAgent({ launcher: "/Users/a b/bin/laplace-runtime", profile: "hosted" });
	expect(plist).toContain("<string>com.withlaplace.runtime</string>");
	expect(plist).toContain("<string>/Users/a b/bin/laplace-runtime</string>");
	expect(plist).toContain("<string>login</string>");
	expect(plist).not.toContain("KeepAlive");
	const unit = systemdUnit({ launcher: "/home/a/bin/laplace-runtime", profile: "hosted" });
	expect(unit).toContain('ExecStart="/home/a/bin/laplace-runtime" "login" "--profile" "hosted"');
	expect(unit).not.toMatch(/Restart=(always|on-)/);
	expect(
		windowsRunCommand({
			launcher: "C:\\Users\\a\\bin\\laplace-runtime.cmd",
			hidden: "C:\\Users\\a\\bin\\laplace-runtime-hidden.exe",
			profile: "hosted",
		}),
	).toBe(
		'"C:\\Users\\a\\bin\\laplace-runtime-hidden.exe" "C:\\Users\\a\\bin\\laplace-runtime.cmd" "login" "--profile" "hosted"',
	);
});

it("reports a terminated runtime as stopped to bridges until a user start", async () => {
	const { root, options } = await fixture();
	const descriptor = await startRuntime({ ...options, explicit: true });
	process.kill(descriptor.pid, "SIGKILL");
	await expect.poll(() => readRuntimeDescriptor(root)).toBeUndefined();
	await expect(startRuntime(options)).rejects.toThrow("stopped unexpectedly");
	const restarted = await startRuntime({ ...options, explicit: true });
	expect(restarted.pid).not.toBe(descriptor.pid);
});
