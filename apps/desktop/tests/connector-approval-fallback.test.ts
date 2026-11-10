import { randomUUID } from "node:crypto";

import type { BrowserApprovals } from "@repo/local-runtime/browser-approvals";
import { ConnectorManagement } from "@repo/local-runtime/connector-tools";
import type { DesktopManager } from "@repo/local-runtime/manager";
import { expect, it, vi } from "vitest";

function fixture() {
	const clientId = randomUUID();
	const requestId = randomUUID();
	let permitted = true;
	let expired = false;
	const view = { requestId, state: "approval_required", candidates: [] };
	const manager = {
		client: () => {
			if (!permitted) throw Error("revoked");
		},
		clientToolAllowed: () => permitted,
	} as unknown as DesktopManager;
	const read = (id: string, owner: string) => {
		if (expired || id !== requestId || owner !== clientId) throw Error("Approval unavailable");
		return view;
	};
	const approvals = {
		view: read,
		review: (id: string, owner: string) => ({ view: read(id, owner), capabilities: {} }),
	} as unknown as BrowserApprovals;
	const open = vi.fn(async () => "http://127.0.0.1:1234/request-scoped-page");
	const management = new ConnectorManagement(
		manager,
		{} as ConstructorParameters<typeof ConnectorManagement>[1],
		undefined,
		approvals,
		open,
	);
	return {
		clientId,
		requestId,
		management,
		open,
		revoke: () => {
			permitted = false;
		},
		expire: () => {
			expired = true;
		},
	};
}

it("keeps the legacy tool name while opening the owning client's browser approval page", async () => {
	const f = fixture();
	const result = await f.management.call(f.clientId, "local_connectors_browser_desktop", {
		requestId: f.requestId,
	});
	expect(f.open).toHaveBeenCalledExactlyOnceWith(f.requestId, f.clientId);
	expect(result.structuredContent).toMatchObject({
		requestId: f.requestId,
		url: "http://127.0.0.1:1234/request-scoped-page",
	});
});

it("does not open another client's request or an expired review", async () => {
	const f = fixture();
	await expect(
		f.management.call(randomUUID(), "local_connectors_browser_desktop", { requestId: f.requestId }),
	).rejects.toThrow("Approval unavailable");
	f.expire();
	await expect(
		f.management.call(f.clientId, "local_connectors_browser_desktop", { requestId: f.requestId }),
	).rejects.toThrow("Approval unavailable");
	expect(f.open).not.toHaveBeenCalled();
});

it("rechecks access after the asynchronous page-opening operation", async () => {
	const f = fixture();
	f.open.mockImplementationOnce(async () => {
		f.revoke();
		return "http://127.0.0.1:1234/request-scoped-page";
	});
	await expect(
		f.management.call(f.clientId, "local_connectors_browser_desktop", { requestId: f.requestId }),
	).rejects.toThrow("revoked");
});
