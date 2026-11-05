import { manageDesktop } from "@repo/local-runtime/desktop-tools";
import { expect, it, vi } from "vitest";

function fixture() {
	const manager: any = {
		client: vi.fn(),
		clientToolAllowed: vi.fn(() => true),
		status: () => ({
			mode: "linked",
			origin: "https://connect.withlaplace.com",
			accountId: "account",
			installationId: "device",
			error: "canary",
			servers: [
				{
					id: "one",
					name: "One",
					enabled: true,
					status: "online",
					args: ["canary"],
					diagnostic: ["canary"],
				},
			],
			clients: [{ tokenHash: "canary" }],
		}),
		restartServer: vi.fn(),
		setEnabled: vi.fn(),
	};
	const hosted: any = {
		status: vi.fn(() => ({ hosted: "disconnected" })),
		connect: vi.fn(),
		disconnect: vi.fn(),
	};
	const open = vi.fn();
	return {
		manager,
		hosted,
		open,
		call: (args: unknown) => manageDesktop(manager, hosted, "self", args, open),
	};
}
it("returns only safe status fields, never raw config, diagnostics or registration secrets", async () => {
	const f = fixture();
	const result = await f.call({ action: "status" });
	expect(JSON.stringify(result)).not.toContain("canary");
	expect(result.assistant.id).toBe("self");
});
it("starts consent only for the invoking assistant and does not restart pending consent", async () => {
	const f = fixture();
	await f.call({ action: "authorize", desktopManagement: true });
	expect(f.hosted.connect).toHaveBeenCalledWith("self", true, true);
	f.hosted.status.mockReturnValue({ hosted: "connecting" });
	await f.call({ action: "authorize", desktopManagement: true });
	expect(f.hosted.connect).toHaveBeenCalledTimes(1);
	await expect(f.call({ action: "authorize", clientId: "other" })).rejects.toThrow();
});
it("enforces management permissions and cannot approve or edit grants", async () => {
	const f = fixture();
	f.manager.clientToolAllowed.mockImplementation(
		(_id: string, tool: string) => tool !== "local_connectors_manage",
	);
	await expect(f.call({ action: "restart", id: "one" })).rejects.toThrow();
	expect(f.manager.restartServer).not.toHaveBeenCalled();
	await expect(f.call({ action: "approve" })).rejects.toThrow();
	f.manager.clientToolAllowed.mockReturnValue(false);
	await expect(f.call({ action: "status" })).rejects.toThrow();
});
it("opens a bounded settings section and controls connector lifecycle", async () => {
	const f = fixture();
	await f.call({ action: "open", section: "device" });
	expect(f.open).toHaveBeenCalledWith("device");
	await f.call({ action: "stop", id: "one" });
	expect(f.manager.setEnabled).toHaveBeenCalledWith("one", false);
	await expect(f.call({ action: "open", section: "https://example.com" })).rejects.toThrow();
});
