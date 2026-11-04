import {
	BrowserApprovals as SharedBrowserApprovals,
	browserConsentSchema,
} from "@repo/browser-runtime/browser-approvals";
import { EncryptedStore } from "@repo/local-mcp-core/encrypted-store";

import type { DesktopManager } from "./manager";
export { browserAuthorizer } from "@repo/browser-runtime/browser-approvals";
export class BrowserApprovals extends SharedBrowserApprovals {
	constructor(manager: DesktopManager) {
		super(
			manager,
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
