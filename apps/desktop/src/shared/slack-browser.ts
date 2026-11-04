/** Desktop-owned Slack adapter; browser credentials never cross this protocol. */
export const slackBrowserVersion = "2.0.0-desktop.1";
export const slackReadNames = [
	"channels_list",
	"conversations_history",
	"conversations_replies",
	"conversations_search_messages",
];
export const slackSetupNames = [
	"laplace_browser_pair",
	"laplace_browser_status",
	"laplace_browser_review",
	"laplace_browser_authorize",
	"laplace_browser_focus",
	"laplace_browser_revoke",
];
export function slackWorkspace(value: string) {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash ||
		!["", "/"].includes(url.pathname) ||
		!/^[a-z0-9-]+\.(slack\.com|slack-gov\.com)$/.test(url.hostname) ||
		/^(app|api|edgeapi)\./.test(url.hostname)
	)
		throw new Error("Enter a Slack workspace HTTPS URL.");
	return url.origin;
}
