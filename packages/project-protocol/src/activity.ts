import type { BuildProvider } from "./handoff";

export interface AgentClientIdentity {
	displayName: string;
	provider: BuildProvider;
}

/** Recognize application identity without exposing opaque OAuth IDs or metadata URLs. */
export function identifyAgentClient(value: string): AgentClientIdentity | null {
	const name = value.trim().toLowerCase();
	if (/^claude[ -]+code(?:\b|$)/.test(name))
		return { displayName: "Claude Code", provider: "claude" };
	if (/^codex(?:\b|$)/.test(name)) return { displayName: "Codex", provider: "codex" };
	if (["chatgpt", "laplace-chatgpt"].includes(name))
		return { displayName: "ChatGPT", provider: "chatgpt" };
	if (name === "claude") return { displayName: "Claude", provider: "claude" };
	if (name === "cursor") return { displayName: "Cursor", provider: "cursor" };
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return null;
		if (url.hostname === "chatgpt.com") {
			if (url.pathname === "/connector/oauth/codex.json")
				return { displayName: "Codex", provider: "codex" };
			return { displayName: "ChatGPT", provider: "chatgpt" };
		}
		if (["claude.ai", "claude.com"].includes(url.hostname))
			return { displayName: "Claude", provider: "claude" };
		if (["cursor.com", "www.cursor.com"].includes(url.hostname))
			return { displayName: "Cursor", provider: "cursor" };
	} catch {
		// Most client IDs and registered names are not URLs.
	}
	return null;
}

/** Authenticated project-source metadata. Never contains credentials or source bodies. */
export interface ProjectActivityEvent {
	id: string;
	at: string;
	actor: string;
	client: string;
	type: string;
	outcome: string;
	revision: string;
	operation_id?: string;
	paths?: string[];
}
export interface DesignFile {
	path: string;
	bytes: number;
	hash: string;
	updated_at: string | null;
	actor: string | null;
}
export interface ActivityPage {
	events: ProjectActivityEvent[];
	next_cursor: string | null;
}
export interface DesignPage {
	files: DesignFile[];
	next_cursor: string | null;
}
