import { afterEach, describe, expect, it, vi } from "vitest";

import { sign, verify } from "./security";
import { signedWorkspaceHeaders, verifyWorkspaceRequest } from "./signing";

afterEach(() => vi.restoreAllMocks());

describe("published app request signing", () => {
	const secret = "s".repeat(32);
	const body = '{"projectId":"existing-project"}';
	const now = 1_700_000_000_000;

	it("preserves the deployed HMAC wire format and rejects a changed audience or body", async () => {
		vi.spyOn(Date, "now").mockReturnValue(now);
		const headers = await signedWorkspaceHeaders(secret, "connect-project", body);
		expect(headers["X-Laplace-Signature"]).toBe(
			"a461003fbe845742e86fe9f397a6f3d604da2296c608ab8e62fd5ff076185d4e",
		);
		const request = new Request("https://builder.example", { headers });
		expect(await verifyWorkspaceRequest(request, secret, "connect-project", body)).toBe(true);
		expect(await verifyWorkspaceRequest(request, secret, "connect-authority", body)).toBe(false);
		expect(await verifyWorkspaceRequest(request, secret, "connect-project", `${body} `)).toBe(
			false,
		);
	});

	it("rejects expired timestamps, invalid signatures and missing configuration", async () => {
		vi.spyOn(Date, "now").mockReturnValue(now);
		const headers = await signedWorkspaceHeaders(secret, "project", body);
		vi.spyOn(Date, "now").mockReturnValue(now + 30_000);
		expect(
			await verifyWorkspaceRequest(
				new Request("https://builder.example", { headers }),
				secret,
				"project",
				body,
			),
		).toBe(false);
		expect(
			await verifyWorkspaceRequest(
				new Request("https://builder.example", { headers }),
				undefined,
				"project",
				body,
			),
		).toBe(false);
		expect(await verify(secret, body, "not-a-signature")).toBe(false);
		await expect(signedWorkspaceHeaders("short", "project", body)).rejects.toThrow(
			"not configured",
		);
	});

	it("matches standard HMAC signatures", async () => {
		const signature = "3c3ed273dafb6dab575d23689d4be05bb309deb1a285a34c6c60359826c146e1";
		expect(await sign(secret, body)).toBe(signature);
		expect(await verify(secret, body, signature)).toBe(true);
		expect(await verify(secret, body, signature.toUpperCase())).toBe(false);
	});
});
