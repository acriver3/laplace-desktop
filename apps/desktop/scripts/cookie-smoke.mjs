import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";

import { testEnvironment } from "./test-environment.mjs";

const root = await mkdtemp(join(tmpdir(), "laplace-desktop-cookie-"));
try {
	const child = spawn(
		electron,
		[fileURLToPath(new URL("../tests/fixtures/cookie-session.cjs", import.meta.url))],
		{ env: testEnvironment({ LAPLACE_COOKIE_TEST_ROOT: root }), stdio: "inherit" },
	);
	const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
	try {
		const code = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolve(code ?? 1));
		});
		if (code !== 0) process.exitCode = 1;
	} finally {
		clearTimeout(timer);
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
