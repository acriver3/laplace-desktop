import { providerDestination } from "@repo/project-protocol/handoff";
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
	return [
		`Help me set up ${entry.name} in my existing Laplace Desktop client on this computer (${environment} environment). Do not install another Laplace client or configure a separate standalone server.`,
		`Catalog connector: ${entry.id}${entry.version ? `, version ${entry.version}` : ""}.`,
		"Use this existing Laplace Desktop client's registered local MCP connection for setup, not computer-use automation, hosted service actions, or a standalone MCP server. Discover its tools directly. If local_connectors_list is unavailable, report the missing capability and check the installed Desktop version and registration; do not silently switch to UI automation or install another client.",
		"Call local_connectors_list and local_connectors_status to inspect the catalog and existing connections first. Reuse an existing catalog installation when possible. If a custom connection has the same name or ID, explain the conflict and ask before removing or replacing it. Preserve unrelated connections and credentials.",
		`Gather only missing setup details: ${entry.fields.map((field) => `${field.label}${field.required ? " (required)" : " (optional)"}`).join(", ") || "no additional configuration"}. Read the current catalog's configuration fields and reuse its suggested defaults when appropriate. Ask me for missing information rather than guessing my workspace or account.`,
		`For a new connection, call local_connectors_install with the discovered catalog ID ${entry.id}, a stable idempotencyKey and the required nonsensitive configuration. Use local_connectors_manage for configuration and resume durable operation status after reconnecting. Complete sensitive settings in Desktop. Poll local_connectors_status using the returned job ID until installation completes. After an uncertain result or reconnect, inspect status before retrying; do not create duplicate connections.`,
		"Use local_connectors_authenticate and follow the connector's current authentication instructions. For browserApproval, render local_connectors_browser_show with its requestId so I can approve the account in chat; use local_connectors_browser_desktop if the host does not support MCP Apps. Let me complete provider sign-in and MFA myself. Poll the setup job with local_connectors_status. Do not ask for passwords or tokens in chat, read keychains, or copy browser cookies. Never edit Laplace's encrypted storage directly.",
		...(entry.authentication ?? []),
		"Call local_connectors_verify, poll local_connectors_status until verification succeeds, and refresh the MCP tool list to check discovered tools before reporting success. Do not test by sending messages or making other writes. Explain any unresolved setup error or tool-permission restriction. Keep account linking and assistant tool permissions unchanged unless I explicitly request those changes. A prepared prompt or installed bundle alone is not a verified connection.",
	].join("\n\n");
}

export function catalogSetupDestination(target: CatalogSetupTarget, prompt: string) {
	if (target === "cursor" || target === "hermes") return null;
	if (target === "chatgpt") return providerDestination("chatgpt", prompt, "desktop");
	return assistantSetupDestination(target, prompt);
}
