import {
	BrowserApprovals as SharedBrowserApprovals,
	browserConsentSchema,
} from "@repo/browser-runtime/browser-approvals";
import { EncryptedStore } from "@repo/local-mcp-core/encrypted-store";

import type { DesktopManager } from "./manager";
export { browserAuthorizer } from "@repo/browser-runtime/browser-approvals";

export class BrowserApprovals extends SharedBrowserApprovals {
	private established = new Set<string>();
	private recordEstablishedSessions() {
		const sessions = this.list();
		const current = new Set(sessions.map((session) => session.requestId));
		for (const id of this.established) if (!current.has(id)) this.established.delete(id);
		for (const session of sessions)
			if (session.state === "connected") this.established.add(session.requestId);
	}
	override async initialize() {
		await super.initialize();
		// initialize restores persisted grants; an explicit begin gets a new request ID.
		for (const session of this.list()) this.established.add(session.requestId);
	}
	/** Saved sessions waiting for the browser are idle, unlike an explicit setup request. */
	blocksUpdates() {
		return this.list().some(({ requestId, state }) => {
			if (["connected", "disconnected", "cancelled", "expired"].includes(state)) return false;
			if (
				this.established.has(requestId) &&
				["discovering", "sign_in_required", "permission_required"].includes(state)
			) return false;
			return true;
		});
	}
	constructor(manager: DesktopManager) {
		super(
			{
				root: manager.root,
				getServerConfig: (id) => manager.browserSetupConfig(id),
				client: (id) => manager.client(id),
				clientToolAllowed: (id, tool) => manager.clientToolAllowed(id, tool),
				changed: () => {
					this.recordEstablishedSessions();
					manager.changed();
				},
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
