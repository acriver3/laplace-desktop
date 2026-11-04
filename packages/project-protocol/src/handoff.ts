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
/** Workspace links must not fall through to the published-app launcher. */
export const projectPagePath = (projectId: string) =>
	`/apps/${encodeURIComponent(projectId)}?preview=1`;
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
export function handoffPrompt(input: {
	projectId: string;
	projectUrl: string;
	mcpUrl: string;
	request?: string;
	title?: string;
	status?: string;
}) {
	return `Build this app using Laplace Connect.${input.title ? `\nApp title: ${input.title}` : ""}\nProject ID: ${input.projectId}\nProject page: ${input.projectUrl}\nMCP server: ${input.mcpUrl}${input.status ? `\n${input.status}` : ""}\n\nThis project already exists. Do not create another project. First call get_project_guidelines with project_id=${input.projectId}. Check list_suggestion_tasks at startup and between tasks. Claim queued suggestions assigned to me, use their task_context, and report progress with update_suggestion_task every 30 seconds. Saved changes update Preview automatically; report implemented after the matching source revision activates. Never publish approved suggestions live automatically. Use Laplace Connect to inspect and edit this project's files, inspect storage, save restore points, and inspect automatic Preview updates. deploy_and_verify remains an optional runtime check; Publish builds and checks the captured source. Ask me directly for clarification. Do not publish live or reset data unless I request it. If Connect is unavailable, help me connect it before building.${input.request?.trim() ? `\n\nMy request:\n${input.request.trim()}` : ""}`;
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
