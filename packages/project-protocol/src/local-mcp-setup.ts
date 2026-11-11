/** Public documentation identity is independent of installed runtime identity. */
export type BrowserMode = "tethered" | "background-browser";
export const localConnectorDefinitions = [
	{
		id: "canvas-session-mcp",
		name: "Canvas",
		mode: "background-browser",
		serverId: "canvas-session",
		verify: ["canvas_whoami", "canvas_list_courses"],
	},
	{
		id: "linkedin-mcp-server",
		name: "LinkedIn",
		mode: "background-browser",
		serverId: "linkedin",
		verify: ["get_my_profile"],
	},
	{
		id: "yale-som-ems-mcp",
		name: "Yale SOM EMS",
		mode: "background-browser",
		serverId: "yale-som-ems",
		verify: ["ems_session_status", "ems_list_templates"],
	},
	{
		id: "yale-som-cms-mcp",
		name: "Yale SOM CMS",
		mode: "background-browser",
		serverId: "yale-som-cms",
		verify: ["cms_session_status", "cms_get_dashboard"],
	},
	{
		id: "msoutlook-mcp",
		name: "Outlook",
		mode: "tethered",
		serverId: "outlook",
		verify: ["outlook_status", "outlook_list_folders"],
	},
	{
		id: "slack-mcp-server",
		name: "Slack",
		mode: "tethered",
		serverId: "slack",
		verify: ["channels_list"],
	},
	{
		id: "ycombinator-demo",
		name: "Y Combinator",
		mode: "tethered",
		serverId: "ycombinator-demo",
		verify: ["list_applications"],
		demoOnly: true,
	},
] as const;
export function localConnectorDefinition(id: string) {
	return localConnectorDefinitions.find((entry) => entry.id === id);
}
export function localConnectorMetadata(id: string, tethered = false) {
	const entry = localConnectorDefinition(id);
	if (!entry) throw new Error("Unknown local catalog connector.");
	const browserMode: BrowserMode =
		entry.mode === "tethered" && (tethered || entry.id === "ycombinator-demo")
			? "tethered"
			: "background-browser";
	// Do not relabel historical dedicated-browser releases as tethered.
	const suffix =
		entry.mode === "background-browser"
			? " [Background Browser]"
			: tethered && entry.id !== "ycombinator-demo"
				? " [Tethered]"
				: "";
	return {
		name: entry.name + suffix + (entry.id === "ycombinator-demo" ? " · Demo Only" : ""),
		browserMode,
		setupUrl: localConnectorSetupUrl(id),
	};
}
export function localConnectorSetupUrl(
	id: string,
	context: { organization?: string; environment?: string; version?: string } = {},
) {
	if (!localConnectorDefinition(id)) throw new Error("Unknown local catalog connector.");
	const url = new URL(`/local-mcp/setup/${id}`, "https://connect.laplaceop.com");
	for (const key of ["organization", "environment", "version"] as const) {
		const value = context[key];
		if (value) {
			if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))
				throw new Error("Invalid setup context.");
			url.searchParams.set(key, value);
		}
	}
	return url.href;
}
export function localConnectorSetupPrompt(
	entry: { id: string; name: string },
	context: Parameters<typeof localConnectorSetupUrl>[1] = {},
) {
	return `Please set up ${entry.name} with Laplace using these instructions: ${localConnectorSetupUrl(entry.id, context)}`;
}
