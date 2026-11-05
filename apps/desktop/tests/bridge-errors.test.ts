import { SdkHttpError, SdkErrorCode } from "@modelcontextprotocol/client";
import { bridgeCallMessage, bridgeConnectionMessage } from "@repo/local-runtime/bridge-errors";
import { expect, it } from "vitest";

it("distinguishes work not started from uncertain execution without exposing transport details", () => {
	const error = (status: number) =>
		new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "synthetic-secret", { status });
	expect(bridgeConnectionMessage(error(429))).toContain("busy");
	expect(bridgeConnectionMessage(error(401))).toContain("rejected this client's registration");
	expect(bridgeCallMessage(new Error("synthetic-secret"), false)).toContain("not started");
	expect(bridgeCallMessage(new Error("synthetic-secret"), true)).toContain(
		"outcome may be unknown",
	);
	for (const status of [401, 403, 429])
		expect(bridgeCallMessage(error(status), true)).toContain("not started");
	for (const value of [error(429), error(401), error(500), new Error("synthetic-secret")]) {
		expect(bridgeConnectionMessage(value)).not.toContain("synthetic-secret");
		expect(bridgeCallMessage(value, true)).not.toContain("synthetic-secret");
	}
});
