import { expect, it } from "vitest";

import { handoffPrompt, providerDestination, providerActions, type BuildProvider } from "./handoff";
it("hands off an existing project without inventing web prefill formats", () => {
	const prompt = handoffPrompt({
		projectId: "abc",
		projectUrl: "https://connect.example/apps/abc",
		mcpUrl: "https://connect.example/mcp",
		request: "Build a tracker",
	});
	expect(prompt).toContain("Do not create another project");
	expect(prompt).toContain("get_project_guidelines");
	expect(providerDestination("chatgpt", prompt)).toBe("https://chatgpt.com/");
	expect(providerDestination("claude", prompt)).toBe("https://claude.ai/");
	expect(new URL(providerDestination("codex", prompt)!).searchParams.get("prompt")).toBe(prompt);
	expect(providerDestination("other", prompt)).toBeNull();
	expect(providerDestination("codex", "x".repeat(12001))).toBeNull();
});

it("offers only supported targets for each assistant", () => {
	expect(providerActions).toEqual({
		chatgpt: ["browser", "desktop"],
		claude: ["browser", "desktop"],
		codex: ["desktop"],
		cursor: ["copy"],
		other: ["copy"],
	});
	expect(providerDestination("claude", "Build", "desktop")).toBe("claude://claude.ai/new?q=Build");
	expect(providerDestination("codex", "Build", "browser")).toBeNull();
	expect(providerDestination("other", "Build", "browser")).toBeNull();
});

it.each<BuildProvider>(["chatgpt", "codex"])(
	"prefills an unsent %s desktop draft safely",
	(provider) => {
		const prompt = "Build a board & café\nKeep /apps/abc?preview=1 and #notes";
		const destination = new URL(providerDestination(provider, prompt, "desktop")!);
		expect(destination.protocol).toBe("codex:");
		expect(destination.host).toBe("threads");
		expect(destination.pathname).toBe("/new");
		expect([...destination.searchParams.keys()]).toEqual(["prompt"]);
		expect(destination.searchParams.get("prompt")).toBe(prompt);
		expect(providerDestination(provider, "x".repeat(12000), "desktop")).not.toBeNull();
		expect(providerDestination(provider, "x".repeat(12001), "desktop")).toBeNull();
	},
);
