import { isAbsolute, resolve } from "node:path";

import type { ServerConfig } from "@repo/local-mcp-core/config";
import { LocalStore, type EntryFactory } from "@repo/local-mcp-core/store";

import { configurationSummary } from "./imports";

/** Only reads the legacy store. Pairing, credentials, permissions and sessions are never transferred. */
export async function previewLegacyMigration(legacyRoot: string, entries?: EntryFactory) {
	if (!isAbsolute(legacyRoot))
		throw new Error("Choose the absolute Laplace Local state directory.");
	const state = await new LocalStore(resolve(legacyRoot), entries).read();
	return {
		source: resolve(legacyRoot),
		entries: state.servers.map((server) => configurationSummary({ ...server, enabled: false })),
		notice:
			"Selected connections are copied disabled. Stop the old wrapper before enabling them here. Existing sessions and the old installation remain unchanged.",
	};
}

export async function migrateSelectedLegacy(
	legacyRoot: string,
	selectedIds: string[],
	entries?: EntryFactory,
): Promise<ServerConfig[]> {
	if (!isAbsolute(legacyRoot))
		throw new Error("Choose the absolute Laplace Local state directory.");
	if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length)
		throw new Error("Select the connections to migrate.");
	const state = await new LocalStore(resolve(legacyRoot), entries).read();
	return selectedIds.map((id) => {
		const server = state.servers.find((entry) => entry.id === id);
		if (!server)
			throw new Error("A selected connection no longer exists. Preview migration again.");
		return { ...server, generation: crypto.randomUUID(), enabled: false };
	});
}
