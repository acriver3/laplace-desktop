import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const environment = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	homedir: () => environment.home,
}));

import {
	defaultDestination,
	exists,
	packageDigest,
	readJson,
	repository,
	writeJson,
	type Installation,
} from "../src/update/common";
import {
	backupPath,
	installPrepared,
	recoverInstallation,
	stagedPackage,
	validatePending,
	type InstallerHost,
} from "../src/update/installer";

let root: string, installation: Installation, id: string;
beforeEach(async () => {
	environment.home = await mkdtemp(join(tmpdir(), "laplace-installer-test-"));
	root = join(environment.home, "updates");
	// Windows destination derives from LOCALAPPDATA, which must be isolated too.
	vi.stubEnv("LOCALAPPDATA", environment.home);
	installation = {
		protocol: 1,
		id: randomUUID(),
		owner: userInfo().username,
		repository,
		target: process.platform === "win32" ? "win32-x64" : "darwin-arm64",
		path: defaultDestination(),
		version: "0.1.0",
		commit: "a".repeat(40),
		git: process.execPath,
		node: process.execPath,
		pnpm: process.execPath,
		toolPath: process.env.PATH ?? "",
	};
	await mkdir(installation.path, { recursive: true });
	await writeFile(join(installation.path, "app"), "old");
	id = randomUUID();
	const candidate = stagedPackage(root, id);
	await mkdir(candidate, { recursive: true });
	await writeFile(join(candidate, "app"), "new");
	await writeJson(join(root, "installation.json"), installation);
	await writeJson(join(root, "pending.json"), {
		id,
		installationId: installation.id,
		version: "0.2.0",
		commit: "b".repeat(40),
		digest: await packageDigest(candidate),
	});
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(environment.home, { recursive: true, force: true });
});
const host = (): InstallerHost => ({
	launch: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
	waitForHealth: vi.fn(async () => {}),
});

test("verified installation preserves the old app and commits metadata only after health", async () => {
	const adapter = host();
	adapter.waitForHealth = async () => {
		expect(((await readJson(join(root, "installation.json"))) as Installation).version).toBe(
			"0.1.0",
		);
		expect(await readFile(join(installation.path, "app"), "utf8")).toBe("new");
	};
	await installPrepared(root, installation, adapter);
	expect(((await readJson(join(root, "installation.json"))) as Installation).version).toBe("0.2.0");
	expect(await readFile(join(backupPath(installation), "app"), "utf8")).toBe("old");
	expect(await exists(join(root, "journal.json"))).toBe(false);
});

test("startup failure restores the old app and its source identity", async () => {
	const adapter = host();
	adapter.waitForHealth = async () => {
		throw new Error("startup failed");
	};
	await expect(installPrepared(root, installation, adapter)).rejects.toThrow("startup failed");
	expect(await readFile(join(installation.path, "app"), "utf8")).toBe("old");
	expect(((await readJson(join(root, "installation.json"))) as Installation).version).toBe("0.1.0");
	expect(adapter.launch).toHaveBeenCalledTimes(2);
});

test("changed staged package is rejected before replacing the current app", async () => {
	await writeFile(join(stagedPackage(root, id), "app"), "tampered");
	await expect(installPrepared(root, installation, host())).rejects.toThrow("changed");
	expect(await readFile(join(installation.path, "app"), "utf8")).toBe("old");
});

test("power loss between directory renames recovers the previous app", async () => {
	const next = await validatePending(root, installation);
	await writeJson(join(root, "journal.json"), { previous: installation, next, phase: "replacing" });
	await rename(installation.path, backupPath(installation));
	await recoverInstallation(root, host());
	expect(await readFile(join(installation.path, "app"), "utf8")).toBe("old");
	await recoverInstallation(root, host()); // Recovery is idempotent.
});

test("accepted journal completes metadata after an interrupted final write", async () => {
	const next = await validatePending(root, installation);
	await writeJson(join(root, "journal.json"), { previous: installation, next, phase: "accepted" });
	const adapter = host();
	await recoverInstallation(root, adapter);
	expect(((await readJson(join(root, "installation.json"))) as Installation).version).toBe("0.2.0");
	expect(adapter.launch).not.toHaveBeenCalled();
});
