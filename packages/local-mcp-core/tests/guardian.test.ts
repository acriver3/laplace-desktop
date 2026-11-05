import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "esbuild";
import { it, expect } from "vitest";
it("cleans managed descendants when the wrapper is killed without shutdown handlers", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-guardian-"));
	const bundled = await build({
		entryPoints: ["tests/fixtures/guardian.ts"],
		bundle: true,
		platform: "node",
		format: "cjs",
		write: false,
	});
	await writeFile(join(root, "launcher.cjs"), bundled.outputFiles[0].contents);
	const wrapper = spawn(
		process.execPath,
		[
			join(root, "launcher.cjs"),
			root,
			resolve("../../apps/desktop/resources"),
			resolve("tests/fixtures/mcp.mjs"),
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let managed: number | undefined, descendant: number | undefined;
	async function running(pid: number) {
		try {
			process.kill(pid, 0);
			if (process.platform === "linux" && /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8")))
				return false;
			return true;
		} catch {
			return false;
		}
	}
	try {
		const ids = await new Promise<{ managed: number; descendant: number }>((resolve, reject) => {
			let buffer = "";
			wrapper.stdout.on("data", (data) => {
				buffer += data.toString();
				if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]));
			});
			wrapper.once("error", reject);
			wrapper.once("exit", (code) => {
				if (code) reject(new Error("Guardian fixture exited"));
			});
		});
		managed = ids.managed;
		descendant = ids.descendant;
		expect(await running(descendant)).toBe(true);
		wrapper.kill("SIGKILL");
		for (
			let attempt = 0;
			attempt < 60 && ((await running(managed)) || (await running(descendant)));
			attempt++
		)
			await new Promise((r) => setTimeout(r, 50));
		expect(await running(managed)).toBe(false);
		expect(await running(descendant)).toBe(false);
	} finally {
		wrapper.kill();
		if (managed)
			try {
				if (process.platform === "win32") process.kill(managed);
				else process.kill(-managed, "SIGKILL");
			} catch {}
		await rm(root, { recursive: true, force: true });
	}
}, 10_000);
