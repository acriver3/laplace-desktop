import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

// @ts-expect-error Build scripts run directly as JavaScript.
import { macSigningEnvironment } from "../scripts/mac-signing.mjs";

const homes: string[] = [];
async function localConfiguration(value: string) {
	const home = await mkdtemp(join(tmpdir(), "laplace-signing-"));
	homes.push(home);
	const directory = join(home, "Library/Application Support/Laplace/build");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "signing.json"), value);
	return home;
}
afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it("reuses the saved identity when source updates provide no signing environment", async () => {
	const identity = "0123456789abcdef0123456789abcdef01234567";
	const home = await localConfiguration(JSON.stringify({ kind: "local", identity }));
	expect(await macSigningEnvironment({}, home)).toEqual({
		LAPLACE_MAC_SIGN_IDENTITY: identity,
		LAPLACE_MAC_SIGN_KIND: "local",
	});
});

it("lets an explicit release identity override local development signing", async () => {
	const home = await localConfiguration("invalid local configuration");
	const environment = { LAPLACE_MAC_SIGN_IDENTITY: "Developer ID Application: Laplace" };
	expect(await macSigningEnvironment(environment, home)).toEqual({
		LAPLACE_MAC_SIGN_IDENTITY: "Developer ID Application: Laplace",
		LAPLACE_MAC_SIGN_KIND: "developer-id",
	});
});

it("fails on damaged local settings instead of silently changing the signing identity", async () => {
	const home = await localConfiguration(JSON.stringify({ kind: "local", identity: "missing" }));
	await expect(macSigningEnvironment({}, home)).rejects.toThrow("Invalid local signing configuration");
});

it("keeps the existing fallback when the user has not configured local signing", async () => {
	const home = await localConfiguration("{}");
	await rm(join(home, "Library/Application Support/Laplace/build/signing.json"));
	expect(await macSigningEnvironment({}, home)).toEqual({});
});
