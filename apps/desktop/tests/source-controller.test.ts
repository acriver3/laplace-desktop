import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	checkReleaseIndex: vi.fn(),
	installation: {
		id: "00000000-0000-4000-8000-000000000001",
		path: "/fixture/Laplace.app",
		target: "darwin-arm64",
		git: "/fixture/git",
	},
}));
vi.mock("../src/update/common", async (original) => ({
	...(await original<typeof import("../src/update/common")>()),
	run: mocks.run,
	readInstallation: async () => mocks.installation,
}));

vi.mock("../package.json", () => ({ default: { releaseSigningPublicKey: "fixture key" } }));
vi.mock("../src/update/release-manifest", () => ({ checkReleaseIndex: mocks.checkReleaseIndex }));

import { executable, UpdateError, packageDigest } from "../src/update/common";
import { stagedPackage } from "../src/update/installer";
import { SourceUpdater } from "../src/update/source";

let updater: SourceUpdater | undefined, root: string;
afterEach(async () => {
	await updater?.stop();
	if (root) await rm(root, { recursive: true, force: true });
	mocks.run.mockReset();
	mocks.checkReleaseIndex.mockReset();
});
async function create(prepared = false) {
	root = await mkdtemp(join(tmpdir(), "laplace-update-controller-"));
	await writeFile(join(root, "installation.json"), "{}");
	if (prepared) {
		const id = "00000000-0000-4000-8000-000000000002",
			directory = stagedPackage(root, id);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "fixture"), "verified");
		await writeFile(
			join(root, "pending.json"),
			JSON.stringify({
				id,
				installationId: mocks.installation.id,
				version: "0.2.0",
				commit: "a".repeat(40),
				digest: await packageDigest(directory),
			}),
		);
	}
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
	mocks.checkReleaseIndex.mockImplementation(
		() =>
			new Promise<{ commit: string; version: string }>((done) => {
				finish = done;
			}),
	);
	const first = current.check();
	await vi.waitFor(() => expect(mocks.checkReleaseIndex).toHaveBeenCalledTimes(1));
	await current.check();
	expect(mocks.checkReleaseIndex).toHaveBeenCalledTimes(1);
	finish({ commit: "a".repeat(40), version: "0.2.0" });
	await first;
	expect(current.state).toMatchObject({ phase: "available", availableVersion: "0.2.0" });
	expect(mocks.run).not.toHaveBeenCalled();
});
test("offline checks are retryable without losing installed version", async () => {
	const current = await create();
	mocks.checkReleaseIndex.mockRejectedValueOnce(
		new UpdateError("network", "Check your network and Git credentials."),
	);
	await current.check();
	expect(current.state).toMatchObject({ phase: "error", installedVersion: "0.1.0" });
	mocks.checkReleaseIndex.mockResolvedValueOnce(undefined);
	await current.check();
	expect(current.state.phase).toBe("idle");
});
test("cancelled checks cannot leave an available release behind", async () => {
	const current = await create();
	mocks.checkReleaseIndex.mockImplementation(
		(_current, _key, signal) =>
			new Promise((_done, fail) => {
				signal.addEventListener("abort", () =>
					fail(new UpdateError("cancelled", "Update cancelled.")),
				);
			}),
	);
	const pending = current.check();
	await vi.waitFor(() => expect(mocks.checkReleaseIndex).toHaveBeenCalledTimes(1));
	await current.cancel();
	await pending;
	expect(current.state.phase).toBe("idle");
	expect(current.state.availableVersion).toBeUndefined();
});

test("revalidates qualification for a staged update restored after restart", async () => {
	const current = await create(true);
	expect(current.state.phase).toBe("ready");
	expect(current.automaticQualified).toBe(false);
	mocks.checkReleaseIndex.mockResolvedValue({
		version: "0.2.0",
		commit: "a".repeat(40),
		assets: [],
		qualified: [{ target: "darwin-arm64", distribution: "source", evidenceSha256: "b".repeat(64) }],
	});
	await current.check();
	expect(current.state.phase).toBe("ready");
	expect(current.automaticQualified).toBe(true);
});
