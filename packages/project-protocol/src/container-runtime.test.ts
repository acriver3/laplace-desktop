import { describe, expect, it } from "vitest";

import { assessContainerRuntime, containerConfigSchema } from "./container-runtime";
import {
	deploymentSecret,
	readSessionToken,
	sessionToken,
	containerHeaders,
	verifyContainerRequest,
} from "./container-security";

describe("optional container runtime", () => {
	it("never selects or provisions a runtime while assessing source", () => {
		expect(
			assessContainerRuntime({
				"src/index.ts": "export default {fetch(){return new Response('ok')}}",
			}),
		).toEqual({ recommendedRuntime: null, reasons: [], requiresSelection: true });
		const result = assessContainerRuntime({
			"package.json": JSON.stringify({
				dependencies: { next: "16", sharp: "0.34", "@prisma/client": "7" },
			}),
			Dockerfile: "FROM node:24",
			"jobs.py": "print('job')",
		});
		expect(result.recommendedRuntime).toBe("cloudflare-containers");
		expect(result.reasons).toContain("Existing Dockerfile");
		expect(result.reasons).toContain("Python or native binaries");
		expect(result.requiresSelection).toBe(true);
	});
	it("defaults to sleeping with bounded resources and rejects paths and mutable image tags", () => {
		expect(containerConfigSchema.parse({})).toMatchObject({
			keepAlive: false,
			maxInstances: 1,
			idleTimeoutSeconds: 120,
		});
		for (const config of [
			{ dockerfile: "../Dockerfile" },
			{ context: "/root" },
			{ maxInstances: 0 },
			{ maxInstances: 100 },
			{ idleTimeoutSeconds: 0 },
			{ image: "node:latest" },
		])
			expect(containerConfigSchema.safeParse(config).success).toBe(false);
	});
	it("separates app, environment, deployment and request audiences cryptographically", async () => {
		const secret = await deploymentSecret("root".repeat(16), "app-a", "preview", "release-a");
		expect(secret).not.toBe(
			await deploymentSecret("root".repeat(16), "app-b", "preview", "release-a"),
		);
		expect(secret).not.toBe(
			await deploymentSecret("root".repeat(16), "app-a", "production", "release-a"),
		);
		const body = JSON.stringify({ appId: "app-a" });
		const request = new Request("https://connect.test", {
			method: "POST",
			headers: await containerHeaders(secret, "authority", body),
			body,
		});
		expect(await verifyContainerRequest(request, secret, "authority", body)).toBe(true);
		expect(await verifyContainerRequest(request, secret, "control", body)).toBe(false);
		expect(await verifyContainerRequest(request, secret, "authority", body + " ")).toBe(false);
	});
	it("rejects forged, expired and wrong-purpose login tokens", async () => {
		const secret = "test-only".repeat(8);
		const claims = {
			appId: "app",
			environment: "preview",
			deploymentId: "release",
			sessionId: "session",
			id: "nonce",
			expiresAt: Date.now() + 60000,
		};
		const token = await sessionToken(secret, "handoff", claims);
		expect(await readSessionToken(secret, "handoff", token)).toEqual(claims);
		expect(await readSessionToken(secret, "session", token)).toBeNull();
		expect(await readSessionToken(secret, "handoff", token + "a")).toBeNull();
		expect(
			await readSessionToken(
				secret,
				"handoff",
				await sessionToken(secret, "handoff", { ...claims, expiresAt: Date.now() - 1 }),
			),
		).toBeNull();
	});
});
