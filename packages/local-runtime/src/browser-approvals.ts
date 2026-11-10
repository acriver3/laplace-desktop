import {
	BrowserApprovals as SharedBrowserApprovals,
	browserConsentSchema,
} from "@repo/browser-runtime/browser-approvals";
import type { BrowserApprovalView } from "@repo/browser-runtime/browser-approval";
import { EncryptedStore } from "@repo/local-mcp-core/encrypted-store";

import type { DesktopManager } from "./manager";
export { browserAuthorizer } from "@repo/browser-runtime/browser-approvals";

/** Idle browser sessions must not prevent connector or Desktop maintenance. */
export function browserApprovalBlocksUpdate({ state }: Pick<BrowserApprovalView, "state">) {
	return !["connected", "disconnected", "cancelled", "expired"].includes(state);
}

export class BrowserApprovals extends SharedBrowserApprovals {
	constructor(manager: DesktopManager) {
		super(
			{
				root: manager.root,
				getServerConfig: (id) => manager.browserSetupConfig(id),
				client: (id) => manager.client(id),
				clientToolAllowed: (id, tool) => manager.clientToolAllowed(id, tool),
				changed: () => manager.changed(),
				catalogSetupCall: (id, tool, args, signal) =>
					manager.catalogSetupCall(id, tool, args, signal),
			},
			new EncryptedStore(
				manager.root,
				"browser-consent",
				browserConsentSchema,
				() => ({ grants: [] }),
				manager.entries,
			),
		);
	}
}
