import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	checkPublicRelease: vi.fn(),
	installation: { path: "/fixture/Laplace.app", target: "darwin-arm64", git: "/fixture/git" },
}));
vi.mock("../src/update/common", async (original) => ({
	...(await original<typeof import("../src/update/common")>()),
	run: mocks.run,
	readInstallation: async () => mocks.installation,
}));

vi.mock("../package.json", () => ({ default: { releaseSigningPublicKey: "fixture key" } }));
vi.mock("../src/update/release-manifest", () => ({ checkPublicRelease: mocks.checkPublicRelease }));

import { executable, UpdateError } from "../src/update/common";
import { SourceUpdater } from "../src/update/source";

let updater: SourceUpdater | undefined, root: string;
afterEach(async () => {
	await updater?.stop();
	if (root) await rm(root, { recursive: true, force: true });
	mocks.run.mockReset();
	mocks.checkPublicRelease.mockReset();
});
async function create() {
	root = await mkdtemp(join(tmpdir(), "laplace-update-controller-"));
	await writeFile(join(root, "installation.json"), "{}");
	updater = new SourceUpdater(
		"0.1.0",
		executable(mocks.installation.path, mocks.installation.target),
		() => {},
		root,
	);
	await updater.initialize();
	return updater;
}
test("duplicate checks are serialized and check never builds code", async () => {
	const current = await create();
	let finish!: (value: { commit: string; version: string }) => void;
	mocks.checkPublicRelease.mockImplementation(
		() =>
			new Promise<{ commit: string; version: string }>((done) => {
				finish = done;
			}),
	);
	const first = current.check();
	await vi.waitFor(() => expect(mocks.checkPublicRelease).toHaveBeenCalledTimes(1));
	await current.check();
	expect(mocks.checkPublicRelease).toHaveBeenCalledTimes(1);
	finish({ commit: "a".repeat(40), version: "0.2.0" });
	await first;
	expect(current.state).toMatchObject({ phase: "available", availableVersion: "0.2.0" });
	expect(mocks.run).not.toHaveBeenCalled();
});
test("offline checks are retryable without losing installed version", async () => {
	const current = await create();
	mocks.checkPublicRelease.mockRejectedValueOnce(
		new UpdateError("network", "Check your network and Git credentials."),
	);
	await current.check();
	expect(current.state).toMatchObject({ phase: "error", installedVersion: "0.1.0" });
	mocks.checkPublicRelease.mockResolvedValueOnce(undefined);
	await current.check();
	expect(current.state.phase).toBe("idle");
});
test("cancelled checks cannot leave an available release behind", async () => {
	const current = await create();
	mocks.checkPublicRelease.mockImplementation(
		(_current, _key, signal) =>
			new Promise((_done, fail) => {
				signal.addEventListener("abort", () =>
					fail(new UpdateError("cancelled", "Update cancelled.")),
				);
			}),
	);
	const pending = current.check();
	await vi.waitFor(() => expect(mocks.checkPublicRelease).toHaveBeenCalledTimes(1));
	await current.cancel();
	await pending;
	expect(current.state.phase).toBe("idle");
	expect(current.state.availableVersion).toBeUndefined();
});
