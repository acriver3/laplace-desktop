import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Entry } from "@napi-rs/keyring";

// Run with the same bundled Node executable that created the test credentials.
// Only exact accounts recorded by this synthetic smoke run are deleted.
const journal = JSON.parse(await readFile(process.argv[2], "utf8"));
if (
	typeof journal.root !== "string" ||
	!Array.isArray(journal.keys) ||
	journal.keys.some(
		(name) =>
			typeof name !== "string" || !/^(?:config-key|desktop:key|client:[0-9a-f-]{36})$/.test(name),
	)
)
	throw new Error("Invalid smoke cleanup journal");
const namespace = createHash("sha256").update(resolve(journal.root)).digest("hex");
for (const name of journal.keys)
	new Entry("laplace-local", `${namespace}:${name}`, {
		linux: { store: "secret-service" },
	}).deletePassword();
