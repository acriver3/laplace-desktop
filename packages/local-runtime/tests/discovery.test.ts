import { expect, it, vi } from "vitest";

import { localDiscovery } from "../src/discovery";

function fixture(mode: "local-only" | "linked") {
	const manager = {
		status: () =>
			({
				mode,
				origin: "https://connect.fixture.invalid",
				installationId: mode === "linked" ? "11111111-1111-4111-8111-111111111111" : undefined,
				servers: [
					{
						id: "slack",
						name: "Slack",
						status: "online",
						enabled: true,
						linkMode: "local-only",
						access: { visible: true, remoteEnabled: false },
						tools: [{ enabled: true }, { enabled: false }],
					},
				],
			}) as never,
	};
	const hosted = {
		status: vi.fn(() => ({ hosted: "disconnected" as const })),
		connect: vi.fn(async () => ({ hosted: "connecting" as const })),
	};
	const link = {
		start: vi.fn(async () => ({
			pending: true,
			verificationUrl: "https://connect.fixture.invalid/local-mcp/link",
			approvalCode: "ABCD",
		})),
	};
	const opened: string[] = [];
	const discovery = localDiscovery(
		manager as never,
		hosted as never,
		link as never,
		"https://connect.fixture.invalid",
		(url) => opened.push(url),
	);
	return { discovery, hosted, link, opened };
}

it("reports local connectors without requiring an account", async () => {
	const { discovery } = fixture("local-only");
	const status = (await discovery.status("client")) as any;
	expect(status.account.linked).toBe(false);
	expect(status.connectors).toEqual([
		expect.objectContaining({ name: "Slack", status: "online", tools: 1, sharedRemotely: false }),
	]);
	expect(status.nextSteps.join(" ")).toContain("laplace_setup");
});

it("links the computer first, then connects hosted tools for this client", async () => {
	const unlinked = fixture("local-only");
	const result = (await unlinked.discovery.setup("client", "browser")) as any;
	expect(result.step).toBe("link-computer");
	expect(unlinked.opened).toEqual(["https://connect.fixture.invalid/local-mcp/link"]);
	expect(unlinked.hosted.connect).not.toHaveBeenCalled();
	const linked = fixture("linked");
	expect(((await linked.discovery.setup("client", "browser")) as any).step).toBe(
		"connect-hosted-tools",
	);
	expect(linked.hosted.connect).toHaveBeenCalledWith("client", true);
	expect(linked.link.start).not.toHaveBeenCalled();
});
