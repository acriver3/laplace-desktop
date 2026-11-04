import { BROKER_UI_URI } from "../credential-broker";
import html from "./broker-approval-widget";
export function brokerApprovalResource() {
	return {
		uri: BROKER_UI_URI,
		mimeType: "text/html;profile=mcp-app",
		text: html,
		_meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
	};
}
