import { expect, it } from "vitest";

import {
	catalogSetupDestination,
	catalogSetupPrompt,
	catalogSetupTarget,
} from "../src/shared/catalog-setup";
import { shellRequest } from "../src/shared/shell-contracts";

it("prepares connector-specific guidance without saved settings or credentials", () => {
	const entry = {
		id: "slack-mcp-server",
		name: "Slack",
		version: "1.2.3",
		available: true,
		fields: [
			{
				key: "workspace",
				label: "Slack workspace URL",
				required: true,
				default: "private-workspace",
			},
		],
		authentication: ["Complete browser sign-in and MFA."],
		credentials: { token: "secret-canary" },
	};
	const prompt = catalogSetupPrompt(entry, "Local development");
	for (const text of [
		"Slack",
		"1.2.3",
		"Local development",
		"Slack workspace URL (required)",
		"registered local MCP connection",
		"local_connectors_list",
		"local_connectors_status",
		"local_connectors_install",
		"idempotencyKey",
		"local_connectors_authenticate",
		"local_connectors_verify",
		"ask before removing",
		"MFA",
	])
		expect(prompt).toContain(text);
	expect(prompt).not.toContain("secret-canary");
	expect(prompt).not.toContain("private-workspace");
	expect(prompt).not.toContain("Set up manually");
	expect(prompt).not.toContain("click Connect");
	expect(prompt).toContain("do not silently switch to UI automation");
});

it("uses the web handoff destinations and retains copy-only and oversized prompts", () => {
	const prompt = 'Help with Slack & "MFA"\nnext line';
	for (const [target, prefix] of [
		["codex", "codex://threads/new?prompt="],
		["chatgpt", "codex://threads/new?prompt="],
		["claude-desktop", "claude://claude.ai/new?q="],
		["claude-code", "claude://code/new?q="],
	] as const)
		expect(catalogSetupDestination(target, prompt)).toBe(prefix + encodeURIComponent(prompt));
	for (const target of ["cursor", "hermes", "other"] as const)
		expect(catalogSetupDestination(target, prompt)).toBeNull();
	for (const target of catalogSetupTarget.options)
		expect(catalogSetupDestination(target, "x".repeat(12001))).toBeNull();
});

it("only accepts bounded catalog identity and known agent actions over desktop IPC", () => {
	const request = {
		method: "shell.catalogSetup",
		input: { catalogId: "slack-mcp-server", target: "codex", action: "open" },
	};
	expect(shellRequest.safeParse(request).success).toBe(true);
	for (const input of [
		{ prompt: "untrusted instructions" },
		{ url: "file:///tmp/run" },
		{ target: "shell" },
		{ action: "execute" },
		{ catalogId: "" },
		{ catalogId: "x".repeat(121) },
	])
		expect(
			shellRequest.safeParse({ ...request, input: { ...request.input, ...input } }).success,
		).toBe(false);
});
