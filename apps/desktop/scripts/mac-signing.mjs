import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Reuse an opted-in local identity across source builds and updates. */
export async function macSigningEnvironment(environment = process.env, home = homedir()) {
	if (environment.LAPLACE_MAC_SIGN_IDENTITY)
		return {
			LAPLACE_MAC_SIGN_IDENTITY: environment.LAPLACE_MAC_SIGN_IDENTITY,
			LAPLACE_MAC_SIGN_KIND: environment.LAPLACE_MAC_SIGN_KIND ?? "developer-id",
		};
	const file = join(home, "Library/Application Support/Laplace/build/signing.json");
	let contents;
	try {
		contents = await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	}
	const settings = JSON.parse(contents);
	if (
		settings?.kind !== "local" ||
		typeof settings.identity !== "string" ||
		!/^[a-fA-F0-9]{40}$/.test(settings.identity)
	)
		throw new Error(`Invalid local signing configuration at ${file}.`);
	return {
		LAPLACE_MAC_SIGN_IDENTITY: settings.identity,
		LAPLACE_MAC_SIGN_KIND: "local",
	};
}
