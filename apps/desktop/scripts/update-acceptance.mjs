import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export const acceptanceChecks = [
	"native-install",
	"native-update",
	"crash-recovery",
	"startup-rollback",
	"locked-files",
	"idle-and-active-calls",
	"credentials-and-permissions",
	"retained-pinned-version",
];
export async function verifyAcceptance(directory, hash, target, distribution) {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Acceptance evidence hash is required");
	const bytes = await readFile(join(directory, hash + ".json"));
	if (createHash("sha256").update(bytes).digest("hex") !== hash)
		throw Error("Acceptance evidence changed");
	const evidence = JSON.parse(bytes);
	if (
		evidence.schemaVersion !== 1 ||
		evidence.target !== target ||
		evidence.distribution !== distribution ||
		evidence.result !== "passed" ||
		!/^[a-f0-9]{40}$/.test(evidence.commit) ||
		!evidence.artifactSha256?.match(/^[a-f0-9]{64}$/) ||
		!evidence.reviewer ||
		!Number.isFinite(Date.parse(evidence.completedAt)) ||
		!acceptanceChecks.every((check) => evidence.checks?.[check] === "passed")
	)
		throw Error("Native acceptance is incomplete or belongs to a different distribution");
	return evidence;
}
