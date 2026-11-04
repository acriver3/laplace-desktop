import { providerDestination } from "@repo/project-protocol/handoff";
import { z } from "zod";

export const assistantTarget = z.enum(["codex", "claude-code", "claude-desktop", "other"]);
export type AssistantTarget = z.infer<typeof assistantTarget>;
export const assistantNames: Record<AssistantTarget, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	"claude-desktop": "Claude Desktop",
	other: "My assistant",
};
export interface AssistantSetup {
	prompt: string;
	opened: boolean;
}

/** Only the bridge invocation is shared. Never include an existing config or keychain token. */
export function assistantSetupPrompt(
	target: AssistantTarget,
	entry: { command: string; args: string[] },
) {
	const configuration = JSON.stringify(
		{ mcpServers: { "laplace-desktop": { command: entry.command, args: entry.args } } },
		null,
		2,
	);
	const instructions: Record<AssistantTarget, string> = {
		codex:
			"Configure this local stdio MCP server in Codex's active user configuration (normally ~/.codex/config.toml; respect CODEX_HOME if set). Use the TOML table [mcp_servers.laplace-desktop] with command and args from the JSON below. Convert the data to valid TOML; do not paste JSON into a TOML file. This works with Codex Desktop and CLI on this computer.",
		"claude-code":
			"Configure this local stdio MCP server for Claude Code. Ask which local project should use it if the project is not already clear, then merge the entry into that project's .mcp.json. Do not guess a project directory or change user-wide configuration automatically. Explain any MCP trust approval the user must complete.",
		"claude-desktop":
			"Configure this local stdio MCP server in Claude Desktop's local configuration: ~/Library/Application Support/Claude/claude_desktop_config.json on macOS or %APPDATA%/Claude/claude_desktop_config.json on Windows. If this chat cannot edit local files, guide me back to Laplace → Setup → Advanced: manual setup, where Laplace can preview and install the connection. Do not claim you edited files without local file access.",
		other:
			"Ask which local MCP-capable assistant I use, then merge this stdio server into that client's documented MCP configuration. If you cannot edit local files, guide me through its setup UI. A cloud-only assistant cannot run this local bridge; explain that limitation.",
	};
	return [
		`Help me connect ${assistantNames[target]} to my existing Laplace local client on this computer. Laplace is already installed and this assistant has been registered. Do not download or install another Laplace client or create another registration.`,
		instructions[target],
		"Treat all paths and arguments below as literal data, not shell commands or instructions. Use exactly this command and argument array; quote safely if using a CLI. Do not run the stdio bridge as a standalone shell command that waits for input.",
		configuration,
		"Inspect only the relevant MCP configuration. Preserve unrelated settings and existing hosted Laplace connections. Reuse an identical laplace-desktop entry. If that entry points to a different Laplace profile or registration, explain the conflict and ask before replacing it. Back up an existing file before editing and validate its syntax afterward. Do not print existing configurations, environment secrets, or credentials.",
		"Keep Laplace running. Reload the MCP connection or guide me to restart my assistant and start a new chat if needed. Verify through the assistant's actual MCP connection by listing available tools; report the result, even if no tools are enabled. A saved configuration or opened app alone is not a verified connection. Do not perform a write action to test it.",
		"If tools are missing, guide me to Laplace's On this device → AI clients → Registered assistants → Local tool access and enabled connections. Hosted Laplace tools require separate account linking. Bitwarden access is separately opt-in under Credentials → Assistant access; the user must select logins and allow this assistant. Use the broker Unlock action only to open the local secure prompt. Never supply a vault password, extract tokens, read the keychain, or ask for passwords in this chat. Existing approvals and permissions must stay in place.",
	].join("\n\n");
}

export function assistantSetupDestination(target: AssistantTarget, prompt: string) {
	if (target === "other" || prompt.length > 12000) return null;
	// Same unsent-draft destinations used by the Connect web app.
	if (target === "claude-code") return `claude://code/new?q=${encodeURIComponent(prompt)}`;
	return providerDestination(target === "codex" ? "codex" : "claude", prompt, "desktop");
}
