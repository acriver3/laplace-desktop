import { expect, it } from "vitest";

import {
	catalogSetupDestination,
	catalogSetupError,
	catalogSetupPrompt,
	catalogSetupTarget,
	setupCatalogEntry,
} from "../src/shared/catalog-setup";
import { shellRequest } from "../src/shared/shell-contracts";

it("explains runtime disconnection without leaking arbitrary diagnostics", () => {
	expect(catalogSetupError(new Error("Error invoking remote method 'laplace:request': Error: Laplace Runtime is unavailable or still starting.")))
		.toContain("Restart Laplace Runtime in the tray");
	expect(catalogSetupError(new Error("Runtime is in maintenance"))).toContain("Wait for the update");
	expect(catalogSetupError(new Error("Your Laplace profile changed."))).toContain("profile changed");
	expect(catalogSetupError(new Error("secret-canary"))).not.toContain("secret-canary");
});

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
	expect(prompt).toContain(
		"Please set up Slack with Laplace using these instructions: https://connect.laplaceop.com/local-mcp/setup/slack-mcp-server?environment=Local+development&version=1.2.3",
	);
	expect(prompt).not.toContain("secret-canary");
	expect(prompt).not.toContain("private-workspace");
	expect(prompt).not.toContain("Set up manually");
	expect(prompt).not.toContain("click Connect");
	expect(prompt).toContain("collect missing configuration");
	expect(prompt).toContain("authenticated read");
	expect(prompt).toContain("browser approval page");
});

it("resolves the selected installation and tells the agent to reconnect that exact ID", () => {
	const entries = [
		{ id: "slack-mcp-server", name: "Slack", available: true, fields: [] },
		{
			id: "slack-mcp-server",
			name: "Slack Work",
			available: true,
			fields: [],
			installed: true,
			serverId: "slack-work",
		},
		{
			id: "slack-mcp-server",
			name: "Slack Personal",
			available: true,
			fields: [],
			installed: true,
			serverId: "slack-personal",
		},
	];
	const entry = setupCatalogEntry(entries, "slack-mcp-server", "slack-work");
	expect(entry.name).toBe("Slack Work");
	const prompt = catalogSetupPrompt(entry, "Hosted Laplace", "slack-work");
	expect(prompt).toContain('existing connection with ID "slack-work"');
	expect(prompt).toContain("do not create a duplicate");
	expect(prompt).not.toContain("slack-personal");
	for (const [catalogId, connectionId] of [
		["slack-mcp-server", "missing"],
		["canvas-session-mcp", "slack-work"],
	])
		expect(() => setupCatalogEntry(entries, catalogId!, connectionId)).toThrow(
			"Refresh connections",
		);
	expect(() =>
		setupCatalogEntry([{ ...entries[1]!, available: false }], "slack-mcp-server", "slack-work"),
	).toThrow();
});

it("can hand off a current catalog entry without a bundled instruction page", () => {
	const prompt = catalogSetupPrompt(
		{ id: "additional-connector", name: "Additional connector", available: true, fields: [] },
		"Local development",
	);
	expect(prompt).toContain('catalog entry "additional-connector"');
	expect(prompt).toContain("Discover the available Laplace tools");
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
	expect(
		shellRequest.safeParse({ ...request, input: { ...request.input, connectionId: "slack-work" } })
			.success,
	).toBe(true);
	for (const input of [
		{ prompt: "untrusted instructions" },
		{ url: "file:///tmp/run" },
		{ target: "shell" },
		{ action: "execute" },
		{ catalogId: "" },
		{ catalogId: "x".repeat(121) },
		{ connectionId: "" },
		{ connectionId: "x".repeat(81) },
		{ connectionId: "../other-profile" },
	])
		expect(
			shellRequest.safeParse({ ...request, input: { ...request.input, ...input } }).success,
		).toBe(false);
});
