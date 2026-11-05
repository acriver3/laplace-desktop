import { createHash } from "node:crypto";
import { resolve } from "node:path";
export interface SecretEntry {
	getPassword(): string | null;
	setPassword(value: string): void;
	deletePassword(): void;
}
export type EntryFactory = (name: string) => Promise<SecretEntry>;
export async function systemEntry(root: string, name: string): Promise<SecretEntry> {
	try {
		const { Entry } = await import("@napi-rs/keyring");
		return new Entry(
			"laplace-local",
			`${createHash("sha256").update(resolve(root)).digest("hex")}:${name}`,
			{ linux: { store: "secret-service" } },
		);
	} catch {
		throw new Error(
			"Persistent keychain unavailable. On Linux start/unlock a Secret Service provider; run doctor. No plaintext fallback is available.",
		);
	}
}
