import { providerDestination } from "@repo/project-protocol/handoff";
import { localConnectorSetupPrompt } from "@repo/project-protocol/local-mcp-setup";
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
}
export interface CatalogSetupResult {
	prompt: string;
	opened: boolean;
}

/** Build from the helper's trusted catalog, never renderer-supplied instructions or saved credentials. */
export function catalogSetupPrompt(entry: SetupCatalogEntry, environment: string) {
	return localConnectorSetupPrompt(entry, { environment, version: entry.version });
}

export function catalogSetupDestination(target: CatalogSetupTarget, prompt: string) {
	if (target === "cursor" || target === "hermes") return null;
	if (target === "chatgpt") return providerDestination("chatgpt", prompt, "desktop");
	return assistantSetupDestination(target, prompt);
}
