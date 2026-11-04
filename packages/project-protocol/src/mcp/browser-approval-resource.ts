import html from "./browser-approval-widget";
export function browserApprovalResource() {
	return {
		uri: "ui://laplace/browser-approval.html",
		mimeType: "text/html;profile=mcp-app",
		text: html,
		_meta: {
			ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
			"openai/widgetDescription":
				"Approve access to a signed-in browser account. No browser credentials are shared with the agent.",
		},
	};
}
