import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { shellRequest } from "../src/shared/shell-contracts";
import { releaseAnnotation, releaseEvidenceSchema } from "../src/update/cli";
import {
	assertDestination,
	installationSchema,
	lock,
	newer,
	packageDigest,
	repository,
	run,
	selectRelease,
	toolEnvironment,
	updateLaunchBlocked,
	writeJson,
} from "../src/update/common";
import { SourceUpdater } from "../src/update/source";

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function temporary() {
	const directory = await mkdtemp(join(tmpdir(), "laplace-source-test-"));
	directories.push(directory);
	return directory;
}

test("release selection uses semantic versions, peels annotated tags, and ignores prereleases", () => {
	const hash = "a".repeat(40),
		commit = "b".repeat(40);
	expect(
		selectRelease(
			`${hash}\trefs/tags/desktop-v0.9.0\n${hash}\trefs/tags/desktop-v0.10.0\n${commit}\trefs/tags/desktop-v0.10.0^{}\n${hash}\trefs/tags/desktop-v1.0.0-beta\n${hash}\trefs/tags/other-v9.0.0`,
			"0.9.0",
		),
	).toEqual({ version: "0.10.0", commit });
	expect(selectRelease(`${hash}\trefs/tags/desktop-v0.1.0`, "0.1.0")).toBeUndefined();
	expect(newer("2.0.0", "1.99.99")).toBe(true);
	expect(() => newer("../main", "1.0.0")).toThrow();
});

test("update IPC accepts actions only, never commands, repositories or destinations", () => {
	for (const method of [
		"shell.updateCheck",
		"shell.updateDownload",
		"shell.updateCancel",
		"shell.updateInstall",
	]) {
		expect(shellRequest.parse({ method })).toEqual({ method });
		for (const input of [
			{ command: "echo injected" },
			{ repository: "https://evil.example/app" },
			{ path: "/Applications/Other.app" },
		])
			expect(shellRequest.safeParse({ method, input }).success).toBe(false);
	}
	expect(() => assertDestination("/tmp/Laplace.app")).toThrow();
	expect(installationSchema.safeParse({ repository: repository + "/evil" }).success).toBe(false);
});

test("build subprocesses do not inherit application credentials and failures do not expose output", async () => {
	vi.stubEnv("DATABASE_URL", "secret-database-value");
	vi.stubEnv("GH_TOKEN", "secret-github-value");
	expect(toolEnvironment()).not.toHaveProperty("DATABASE_URL");
	expect(toolEnvironment(true)).not.toHaveProperty("GH_TOKEN");
	await expect(
		run(process.execPath, ["-e", "process.stderr.write('sensitive-token');process.exit(1)"]),
	).rejects.toThrow("update build failed");
	await expect(run("/nonexistent/laplace-node", [])).rejects.toThrow("required build tool");
});

test("cancelling an active build terminates it and permits retry", async () => {
	const controller = new AbortController();
	const pending = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
		signal: controller.signal,
	});
	controller.abort();
	await expect(pending).rejects.toThrow("cancelled");
	expect(await run(process.execPath, ["-e", "process.stdout.write('retry')"])).toBe("retry");
});

test("installation lock excludes concurrent operations and releases after completion", async () => {
	const root = await temporary(),
		release = await lock(root);
	await expect(lock(root)).rejects.toThrow("already running");
	await release();
	await (
		await lock(root)
	)();
});

test("package digest detects altered files", async () => {
	const root = await temporary();
	await mkdir(join(root, "nested"));
	await writeFile(join(root, "nested", "runtime"), "before");
	const before = await packageDigest(root);
	await writeFile(join(root, "nested", "runtime"), "after");
	expect(await packageDigest(root)).not.toBe(before);
});

test("unmanaged installations never start checks or downloads", async () => {
	const root = await temporary(),
		updates: unknown[] = [];
	const updater = new SourceUpdater("0.1.0", "/tmp/unknown", (state) => updates.push(state), root);
	await updater.initialize();
	await updater.check();
	await updater.download();
	expect(updater.state.phase).toBe("unmanaged");
	expect(updates).toHaveLength(1);
	await expect(updater.handoff()).rejects.toThrow("No verified update");
	await updater.stop();
});

test("native release evidence requires all three native platforms", () => {
	const checks = { packaged: "passed", update: "passed", recovery: "passed", execution: "native" };
	const evidence = {
		commit: "a".repeat(40),
		version: "0.2.0",
		localValidation: "passed",
		platforms: { "darwin-arm64": checks, "darwin-x64": checks, "win32-x64": checks },
	};
	expect(releaseEvidenceSchema.safeParse(evidence).success).toBe(true);
	expect(
		releaseEvidenceSchema.safeParse({
			...evidence,
			platforms: { ...evidence.platforms, "darwin-x64": { ...checks, execution: "rosetta" } },
		}).success,
	).toBe(false);
	expect(
		releaseEvidenceSchema.safeParse({ ...evidence, platforms: { "darwin-arm64": checks } }).success,
	).toBe(false);
});

test("explicit user acceptance does not claim native test results", () => {
	const evidence = {
		commit: "a".repeat(40),
		version: "0.1.1",
		localValidation: "passed",
		userAcceptance: {
			statement: "Consider my acceptance as the evidence file",
			acceptedAt: "2026-10-29T17:00:00Z",
			nativeResults: "not-attested",
		},
	};
	const parsed = releaseEvidenceSchema.parse(evidence);
	expect(releaseAnnotation(parsed)).toContain("user accepted publication");
	expect(releaseAnnotation(parsed)).toContain("native test results not attested");
	expect(releaseAnnotation(parsed)).not.toContain("native validation passed");
	expect(releaseEvidenceSchema.safeParse({ ...evidence, localValidation: "failed" }).success).toBe(
		false,
	);
	expect(
		releaseEvidenceSchema.safeParse({
			...evidence,
			userAcceptance: { ...evidence.userAcceptance, statement: " " },
		}).success,
	).toBe(false);
});

test("AI clients cannot relaunch this installation during replacement, but stale markers do not block", async () => {
	const root = await temporary();
	await writeJson(join(root, "installing.json"), {
		pid: process.pid,
		executable: "/fixture/Laplace",
	});
	expect(await updateLaunchBlocked("/fixture/Laplace", root)).toBe(true);
	expect(await updateLaunchBlocked("/other/Laplace", root)).toBe(false);
	await writeJson(join(root, "installing.json"), {
		pid: 2147483647,
		executable: "/fixture/Laplace",
	});
	expect(await updateLaunchBlocked("/fixture/Laplace", root)).toBe(false);
});

test("GUI launches use the recorded build-tool path", async () => {
	vi.stubEnv("PATH", "/missing-gui-path");
	expect(
		await run(process.execPath, ["-e", "process.stdout.write(process.env.PATH)"], {
			toolPath: "/recorded/tool/path",
		}),
	).toBe("/recorded/tool/path");
});
