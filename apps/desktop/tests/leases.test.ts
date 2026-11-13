import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serverConfig } from "@repo/local-mcp-core/config";
import { acquireResourceLeases } from "@repo/local-mcp-core/leases";
import { assertLegacyProcessesStopped } from "@repo/local-runtime/legacy-processes";
import { afterEach, expect, it } from "vitest";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0).reverse()) await work();
});
it("holds canonical working directories exclusively and releases every lease after a partial conflict", async () => {
	const root = await mkdtemp(join(tmpdir(), "desktop-leases-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const profile = join(root, "profile"),
		other = join(root, "other"),
		alias = join(root, "alias");
	await mkdir(profile);
	await mkdir(other);
	await symlink(profile, alias, process.platform === "win32" ? "junction" : "dir");
	const config = serverConfig.parse({
		id: "lease",
		name: "Lease",
		transport: "stdio",
		command: process.execPath,
	});
	const release = await acquireResourceLeases(config, profile);
	cleanup.push(release);
	await expect(acquireResourceLeases(config, alias)).rejects.toThrow("Another Laplace process");
	await expect(
		acquireResourceLeases(
			{
				...config,
				transport: "stdio",
				command: process.execPath,
				args: ["--profile-dir", alias],
				env: {},
			},
			other,
		),
	).rejects.toThrow("Another Laplace process");
	const releaseOther = await acquireResourceLeases(config, other);
	await releaseOther();
	await release();
	const replacement = await acquireResourceLeases(config, alias);
	await replacement();
});
it("requires old wrappers and matching launch paths to stop before migration activation", async () => {
	const config = serverConfig.parse({
		id: "legacy",
		name: "Legacy",
		transport: "stdio",
		command: process.execPath,
		args: [join(tmpdir(), "old-provider.mjs")],
	});
	await expect(
		assertLegacyProcessesStopped(config, async () => [
			{ pid: 12345, command: `node ${join(tmpdir(), "old-provider.mjs")} secret-do-not-return` },
		]),
	).rejects.toThrow("still running");
	await expect(
		assertLegacyProcessesStopped(config, async () => [
			{ pid: 12345, command: "node /opt/local-mcp/dist/cli.cjs" },
		]),
	).rejects.toThrow("still running");
	await expect(
		assertLegacyProcessesStopped(config, async () => [
			{ pid: process.pid, command: "node /opt/local-mcp/dist/cli.cjs" },
		]),
	).resolves.toBeUndefined();
	await expect(
		assertLegacyProcessesStopped(config, async () => {
			throw new Error("secret-do-not-return");
		}),
	).rejects.toThrow("Cannot inspect");
});

it("coordinates CMS state across installed versions without leasing the shared Chrome endpoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "desktop-cms-state-leases-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const state = join(root, "state"),
		alias = join(root, "state-alias");
	await mkdir(state);
	await symlink(state, alias, process.platform === "win32" ? "junction" : "dir");
	const cdp = "ws://127.0.0.1:9222/devtools/browser";
	const config = (version: string, args: string[]) =>
		serverConfig.parse({
			id: "yale-som-cms",
			name: "Yale SOM CMS [Tethered]",
			transport: "stdio",
			command: process.execPath,
			identity: `npm:@withlaplace/yale-som-cms-mcp@${version}`,
			args: ["serve", ...args, "--cdp-url", cdp],
		});
	const current = config("0.1.1", ["--state-dir", state]);
	const next = config("0.1.2", [`--state-dir=${alias}`]);
	const currentDirectory = join(root, "package-0.1.1"),
		nextDirectory = join(root, "package-0.1.2");
	const release = await acquireResourceLeases(current, currentDirectory);
	cleanup.push(release);
	await expect(acquireResourceLeases(next, nextDirectory)).rejects.toThrow(
		"Another Laplace process",
	);
	// Independent state can use the same Chrome connection, and the failed attempt released its cwd.
	const independent = await acquireResourceLeases(
		config("0.1.2", ["--state-dir", join(root, "other-state")]),
		nextDirectory,
	);
	await independent();
	await release();
	const replacement = await acquireResourceLeases(next, nextDirectory);
	cleanup.push(replacement);
	await expect(acquireResourceLeases(current, currentDirectory)).rejects.toThrow(
		"Another Laplace process",
	);
});
