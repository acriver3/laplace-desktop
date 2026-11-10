import { providerDestination } from "@repo/project-protocol/handoff";
import {
	localConnectorDefinition,
	localConnectorSetupPrompt,
} from "@repo/project-protocol/local-mcp-setup";
import { z } from "zod";

import { assistantSetupDestination } from "./assistant-setup";

export const catalogSetupTarget = z.enum([
	"codex",
	"chatgpt",
	"claude-desktop",
	"claude-code",
	"cursor",
	"hermes",
	"other",
]);
export type CatalogSetupTarget = z.infer<typeof catalogSetupTarget>;
export const catalogSetupNames: Record<CatalogSetupTarget, string> = {
	codex: "Codex",
	chatgpt: "ChatGPT",
	"claude-desktop": "Claude",
	"claude-code": "Claude Code",
	cursor: "Cursor",
	hermes: "Hermes",
	other: "Other agent",
};
export interface SetupCatalogEntry {
	id: string;
	name: string;
	version?: string;
	available: boolean;
	fields: Array<{ key: string; label: string; required?: boolean }>;
	authentication?: string[];
	installed?: boolean;
	serverId?: string;
}
export interface CatalogSetupResult {
	prompt: string;
	opened: boolean;
}

/** Build from the helper's trusted catalog, never renderer-supplied instructions or saved credentials. */
export function setupCatalogEntry(
	entries: SetupCatalogEntry[],
	catalogId: string,
	connectionId?: string,
) {
	const entry = entries.find(
		(item) =>
			item.id === catalogId &&
			(!connectionId || (item.installed && item.serverId === connectionId)),
	);
	if (!entry?.available)
		throw new Error("This connection is no longer available. Refresh connections and try again.");
	return entry;
}

export function catalogSetupPrompt(
	entry: SetupCatalogEntry,
	environment: string,
	connectionId?: string,
) {
	return [
		localConnectorDefinition(entry.id)
			? localConnectorSetupPrompt(entry, { environment, version: entry.version })
			: `Please set up ${JSON.stringify(entry.name)} from the current Laplace Desktop catalog.`,
		`Use my existing Laplace Desktop in the ${JSON.stringify(environment)} profile. Discover the available Laplace tools and read their schemas before calling them. Do not install another Laplace client.`,
		connectionId
			? `Reconnect the existing connection with ID ${JSON.stringify(connectionId)} for catalog entry ${JSON.stringify(entry.id)}. Inspect and reuse that exact connection; do not create a duplicate or change another account. If it no longer exists, ask me before creating a replacement.`
			: `Inspect existing connections for catalog entry ${JSON.stringify(entry.id)} before installing. Reuse a matching connection, and ask me which account if more than one could apply.`,
		"Guide setup here in this conversation: collect missing configuration, choose an appropriate sign-in or credential source, and obtain the required user approvals. Never request passwords or tokens in chat. Keep account and credential approval in the agent's approval card; explicitly open the request-scoped browser approval page when a card is unavailable. Local Bitwarden sign-in and unlock remain user-controlled in Credentials, and login selections and assistant permissions are in Credentials → Manage saved logins.",
		"Poll the same setup operation to completion, then verify with an authenticated read. Report the actual outcome; an installed connector or an opened sign-in page is not a verified connection. Do not send messages or perform other business writes to test it.",
	].join("\n\n");
}

export function catalogSetupDestination(target: CatalogSetupTarget, prompt: string) {
	if (target === "cursor" || target === "hermes") return null;
	if (target === "chatgpt") return providerDestination("chatgpt", prompt, "desktop");
	return assistantSetupDestination(target, prompt);
}
