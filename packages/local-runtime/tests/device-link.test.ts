import { expect, it } from "vitest";

import { DeviceLink } from "../src/device-link";

const origin = "https://connect.fixture.invalid";
function fixture(responses: Record<string, unknown[]>) {
	const calls: Array<{ path: string; body: unknown }> = [];
	const completed: unknown[] = [];
	let mode = "local-only";
	const manager = {
		status: () => ({ mode, installationId: undefined, accountId: undefined }) as never,
		prepareLink: async () => {
			mode = "linking";
			return { credentialHash: "hash", installationId: undefined };
		},
		completeLink: async (value: unknown) => {
			completed.push(value);
			mode = "linked";
			return {} as never;
		},
	};
	const link = new DeviceLink(
		manager,
		() =>
			({
				post: async (path: string, body: unknown) => {
					calls.push({ path, body });
					return responses[path]!.shift();
				},
			}) as never,
	);
	return { link, calls, completed };
}

it("links through browser approval and completes once", async () => {
	const pollCode = "poll";
	const { link, calls, completed } = fixture({
		start: [
			{
				pollCode,
				approvalCode: "ABCD-EFGH",
				verificationUrl: `${origin}/local-mcp/link`,
				expiresIn: 300,
				interval: 5,
			},
		],
		poll: [
			{ status: "pending" },
			{ status: "linked", installationId: crypto.randomUUID(), accountId: "acct" },
		],
	});
	const started = await link.start(origin, "Fixture");
	expect(started).toMatchObject({ pending: true, approvalCode: "ABCD-EFGH" });
	expect(calls[0]).toEqual({ path: "start", body: { name: "Fixture", credentialHash: "hash" } });
	// A repeated start reuses the outstanding approval rather than issuing a new credential.
	expect(await link.start(origin, "Fixture")).toMatchObject({ approvalCode: "ABCD-EFGH" });
	expect(calls).toHaveLength(1);
	expect(await link.poll()).toMatchObject({ linked: false, pending: true });
	expect(await link.poll()).toMatchObject({ linked: true, accountId: "acct" });
	expect(completed).toHaveLength(1);
	expect(await link.poll()).toMatchObject({ linked: true, pending: false });
});

it("rejects approval pages on another origin", async () => {
	const { link } = fixture({
		start: [
			{
				pollCode: "p",
				approvalCode: "A",
				verificationUrl: "https://attacker.invalid/link",
				expiresIn: 300,
				interval: 5,
			},
		],
	});
	await expect(link.start(origin, "Fixture")).rejects.toThrow("origin changed");
});
