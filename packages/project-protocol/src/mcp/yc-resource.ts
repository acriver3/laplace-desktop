import { YC_UI_URI } from "./yc-schema";
import widgetHtml from "./yc-widget";

export function ycUiResource(connectOrigin: string) {
	return {
		uri: YC_UI_URI,
		mimeType: "text/html;profile=mcp-app",
		text: widgetHtml,
		_meta: {
			ui: {
				domain: "https://chatgpt-ui.laplaceop.com",
				prefersBorder: true,
				csp: { connectDomains: [], resourceDomains: [] },
			},
			"openai/widgetCSP": {
				redirect_domains: [new URL(connectOrigin).origin, "https://apply.ycombinator.com"],
			},
			"openai/widgetDescription":
				"Edit YC text drafts one question at a time. ChatGPT suggestions are unsaved until the user reviews and saves them. Uploads and submission happen on YC.",
			"openai/ui": { availableDisplayModes: ["inline"] },
		},
	};
}
