import {
	classifyRecovery,
	recoveryDelay,
	sessionRecoveryEnabled,
} from "@repo/browser-runtime/session-recovery";
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllEnvs());
it("requires explicit opt-in", () => {
	vi.stubEnv("LAPLACE_SESSION_RECOVERY_V1", "false");
	expect(sessionRecoveryEnabled()).toBe(false);
	vi.stubEnv("LAPLACE_SESSION_RECOVERY_V1", "true");
	expect(sessionRecoveryEnabled()).toBe(true);
});
it("does not confuse unknown failures with expired authentication", () => {
	expect(classifyRecovery(new Error("session may have expired"))).toEqual({
		state: "unavailable",
		reason: "verification_failed",
	});
	expect(classifyRecovery("invalid_grant").state).toBe("sign_in_required");
	expect(classifyRecovery({ status: 429 }).state).toBe("reconnecting");
	expect(classifyRecovery("identity_mismatch").state).toBe("approval_required");
});
it("bounds backoff and honors provider retry delays", () => {
	expect(recoveryDelay(0, 0, () => 1)).toBe(1000);
	expect(recoveryDelay(4, 0, () => 1)).toBe(16000);
	expect(recoveryDelay(100, 0, () => 1)).toBe(60000);
	expect(recoveryDelay(100, 120000, () => 1)).toBe(120000);
});

it("preserves structured retry metadata and never exposes untrusted reason text", async () => {
	const { recoveryFromResult, recoveryContent, RecoveryError } =
		await import("@repo/browser-runtime/session-recovery");
	const error = recoveryFromResult({
		isError: true,
		structuredContent: {
			recovery: { state: "reconnecting", reason: "provider-private-text" },
			retryAfterMs: 120000,
		},
	})!;
	expect(error.recovery.reason).toBe("verification_failed");
	expect(error.retryAfterMs).toBe(120000);
	expect(
		recoveryContent(new RecoveryError({ state: "reconnecting", reason: "rate_limited" }, 120000)),
	).toMatchObject({ structuredContent: { retryAfterMs: 120000 } });
});
