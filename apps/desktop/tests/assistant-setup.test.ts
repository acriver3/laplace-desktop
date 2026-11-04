import { expect, it } from "vitest";

import { assistantSetupDestination, assistantSetupPrompt } from "../src/shared/assistant-setup";
import { shellRequest } from "../src/shared/shell-contracts";

it("shares only the literal bridge invocation, never other preview fields or credentials", () => {
	const entry = {
		command: "/Users/Someone With Spaces/runtime/node",
		args: ["/path/bridge.cjs", "--root", "/profile/$(do-not-execute)", "--client-id", "fixture-id"],
		env: { TOKEN: "secret-canary" },
	};
	const prompt = assistantSetupPrompt("codex", entry);
	const json = prompt.slice(prompt.indexOf("{\n"), prompt.indexOf("\n\nInspect only"));
	expect(JSON.parse(json)).toEqual({
		mcpServers: { "laplace-desktop": { command: entry.command, args: entry.args } },
	});
	expect(prompt).not.toContain("secret-canary");
	expect(prompt).toContain("CODEX_HOME");
	expect(prompt).toContain("ask before replacing");
	expect(prompt).toContain("actual MCP connection");
});

it("prepares the same unsent drafts as the web flow with a full copy fallback", () => {
	const prompt = 'Set up "Laplace" & preserve paths\nline two';
	for (const [target, destination] of [
		["codex", "codex://threads/new?prompt="],
		["claude-code", "claude://code/new?q="],
		["claude-desktop", "claude://claude.ai/new?q="],
	] as const) {
		expect(assistantSetupDestination(target, prompt)).toBe(
			destination + encodeURIComponent(prompt),
		);
		expect(assistantSetupDestination(target, "x".repeat(12001))).toBeNull();
	}
	expect(assistantSetupDestination("other", prompt)).toBeNull();
});

it("keeps assistant launches behind strict desktop IPC with no arbitrary URL or prompt input", () => {
	const request = {
		method: "shell.assistantSetup",
		input: { clientId: "00000000-0000-4000-8000-000000000001", target: "codex", action: "open" },
	};
	expect(shellRequest.safeParse(request).success).toBe(true);
	for (const extra of [
		{ url: "file:///tmp/a" },
		{ prompt: "arbitrary text" },
		{ target: "shell" },
		{ clientId: "not-an-id" },
	])
		expect(
			shellRequest.safeParse({ ...request, input: { ...request.input, ...extra } }).success,
		).toBe(false);
});
