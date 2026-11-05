import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyAcceptance } from "../scripts/update-acceptance.mjs";
it("keeps explicit user acceptance distinct from native test results", async () => {
	const directory = await mkdtemp(join(tmpdir(), "update-acceptance-"));
	const value = {
		schemaVersion: 1,
		target: "win32-x64",
		distribution: "squirrel",
		commit: "a".repeat(40),
		artifactSha256: "b".repeat(64),
		reviewer: "release operator",
		completedAt: new Date().toISOString(),
		result: "accepted",
		localValidation: "passed",
		userAcceptance: {
			statement: "I accept Windows and Mac publication without native runner evidence.",
			acceptedAt: new Date().toISOString(),
			nativeResults: "not-attested",
		},
	};
	const check = async (data: unknown) => {
		const bytes = Buffer.from(JSON.stringify(data));
		const hash = createHash("sha256").update(bytes).digest("hex");
		await writeFile(join(directory, hash + ".json"), bytes);
		return verifyAcceptance(directory, hash, "win32-x64", "squirrel");
	};
	try {
		await expect(check(value)).resolves.toMatchObject({ result: "accepted" });
		await expect(check({ ...value, result: "passed" })).rejects.toThrow();
		await expect(check({ ...value, checks: { "native-install": "passed" } })).rejects.toThrow();
		await expect(check({ ...value, localValidation: "failed" })).rejects.toThrow();
		await expect(
			check({ ...value, userAcceptance: { ...value.userAcceptance, statement: "" } }),
		).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
