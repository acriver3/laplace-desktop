import { z } from "zod";

import { homeInput } from "./ui-schema";
import widgetHtml from "./widget";

export const HOME_UI_URI = "ui://laplace/home-v1.html";
export const homeUiTools = [
	{
		name: "show_home",
		description:
			"Show Laplace Home: a compact interactive browser of Connected, Available, and Local connectors with logos. Call directly; no preliminary tool call is needed. Search, change section, select an authorized account, or page results with the same tool. Setup and management open in Laplace. Demo presentation never grants connection access.",
		inputSchema: z.toJSONSchema(homeInput, { io: "input" }),
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		_meta: { ui: { visibility: ["model", "app"], resourceUri: HOME_UI_URI } },
	},
];

export function homeUiResource(connectOrigin: string) {
	const origin = new URL(connectOrigin).origin;
	return {
		uri: HOME_UI_URI,
		mimeType: "text/html;profile=mcp-app",
		text: widgetHtml.replaceAll("__LAPLACE_CONNECT_ORIGIN__", origin),
		_meta: {
			ui: {
				domain: "https://chatgpt-ui.laplaceop.com",
				prefersBorder: true,
				csp: { connectDomains: [], resourceDomains: [origin] },
			},
			"openai/widgetCSP": {
				connect_domains: [],
				resource_domains: [origin],
				redirect_domains: [origin],
			},
			"openai/widgetDescription":
				"Laplace Home shows one compact connector section at a time: Connected, Available, or Local. Open setup and details in Laplace.",
			"openai/ui": { availableDisplayModes: ["inline"] },
		},
	};
}
