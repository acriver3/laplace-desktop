export const BUILD_PROVIDERS = ["chatgpt", "claude", "codex", "cursor", "other"] as const;
export type BuildProvider = (typeof BUILD_PROVIDERS)[number];
export type BuildTarget = "browser" | "desktop" | "copy";
export const providerActions: Record<BuildProvider, readonly BuildTarget[]> = {
	chatgpt: ["browser", "desktop"],
	claude: ["browser", "desktop"],
	codex: ["desktop"],
	cursor: ["copy"],
	other: ["copy"],
};
export const buildTargetLabels: Record<BuildTarget, string> = {
	browser: "Build in browser",
	desktop: "Build in desktop",
	copy: "Copy prompt",
};
export const providerLabels: Record<BuildProvider, string> = {
	chatgpt: "ChatGPT",
	claude: "Claude",
	codex: "Codex",
	cursor: "Cursor",
	other: "Other",
};
export function buildProvider(value: unknown): BuildProvider {
	return BUILD_PROVIDERS.includes(value as BuildProvider) ? (value as BuildProvider) : "chatgpt";
}
// Only officially documented prefill is used; web providers use copy + open.
export function providerDestination(
	provider: BuildProvider,
	prompt: string,
	target: BuildTarget = providerActions[provider][0]!,
): string | null {
	if (!providerActions[provider].includes(target)) return null;
	if (target === "browser" && provider === "chatgpt") return "https://chatgpt.com/";
	if (target === "browser" && provider === "claude") return "https://claude.ai/";
	if (target === "desktop" && provider === "claude")
		return prompt.length <= 12000 ? `claude://claude.ai/new?q=${encodeURIComponent(prompt)}` : null;
	// ChatGPT desktop retains this scheme: https://learn.chatgpt.com/docs/reference/commands#deep-links
	// It prepares an unsent draft, never an automatic build.
	if (target === "desktop" && prompt.length <= 12000)
		return `codex://threads/new?prompt=${encodeURIComponent(prompt)}`;
	return null;
}
