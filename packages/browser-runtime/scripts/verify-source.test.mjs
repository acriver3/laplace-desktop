import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { verifyBrowserRuntime } from "./verify-source.mjs";
const source = fileURLToPath(new URL("..", import.meta.url));
test("a consumer accepts the pinned source and rejects changed or injected executable files", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-browser-pin-"));
	try {
		await cp(source, root, { recursive: true, filter: (path) => !path.includes("node_modules") });
		const lock = JSON.parse(await readFile(join(source, "source-lock.json"), "utf8"));
		assert.equal((await verifyBrowserRuntime(root)).files, Object.keys(lock.files).length);
		await writeFile(join(root, "src", "browser-requests.ts"), "changed");
		await assert.rejects(verifyBrowserRuntime(root), /source mismatch/);
		await cp(join(source, "src", "browser-requests.ts"), join(root, "src", "browser-requests.ts"));
		await writeFile(join(root, "extension", "injected.js"), "unexpected");
		await assert.rejects(verifyBrowserRuntime(root), /inventory changed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
