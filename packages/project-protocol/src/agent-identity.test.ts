import { describe, expect, it } from "vitest";

import { identifyAgentClient } from "./activity";

describe("agent application identity", () => {
	it.each([
		["Codex", "Codex", "codex"],
		[" Claude Code ", "Claude Code", "claude"],
		["claude-code", "Claude Code", "claude"],
		["claude", "Claude", "claude"],
		["laplace-chatgpt", "ChatGPT", "chatgpt"],
		["cursor", "Cursor", "cursor"],
		["https://chatgpt.com/connector/oauth/codex.json", "Codex", "codex"],
		["https://chatgpt.com/connector/oauth/client.json", "ChatGPT", "chatgpt"],
		["https://claude.ai/client.json", "Claude", "claude"],
		["https://www.cursor.com/client.json", "Cursor", "cursor"],
	])("recognizes %s", (client, displayName, provider) => {
		expect(identifyAgentClient(client)).toEqual({ displayName, provider });
	});
	it.each([
		"dcr_opaque",
		"Custom agent",
		"https://unknown.example/client.json",
		"https://chatgpt.com.evil.example/client.json",
		"https://user@chatgpt.com/client.json",
		"http://claude.ai/client.json",
	])("does not guess the application for %s", (client) => {
		expect(identifyAgentClient(client)).toBeNull();
	});
});
