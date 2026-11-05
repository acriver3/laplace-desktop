export type RecoveryStatus = {
	state:
		| "reconnecting"
		| "browser_required"
		| "sign_in_required"
		| "approval_required"
		| "unavailable";
	reason: string;
	nextRetryAt?: string;
};
export const sessionRecoveryEnabled = () => process.env.LAPLACE_SESSION_RECOVERY_V1 === "true";
export function classifyRecovery(value: unknown): RecoveryStatus {
	const v = value as { code?: string; status?: number; message?: string } | undefined;
	const code = v?.code ?? (typeof value === "string" ? value : "");
	if (
		[
			"invalid_grant",
			"token_revoked",
			"token_expired",
			"session_expired",
			"sign_in_required",
			"not_authed",
		].includes(code)
	)
		return { state: "sign_in_required", reason: "session_expired" };
	if (["permission_required", "identity_mismatch", "approval_required"].includes(code))
		return { state: "approval_required", reason: code };
	if (
		[
			"browser_required",
			"tab_closed",
			"workspace_tab_required",
			"not_outlook_tab",
			"not_slack_tab",
		].includes(code)
	)
		return { state: "browser_required", reason: "browser_required" };
	if (v?.status === 429 || code === "rate_limited")
		return { state: "reconnecting", reason: "rate_limited" };
	if (
		["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"].includes(code) ||
		(value instanceof Error && ["TimeoutError", "AbortError"].includes(value.name))
	)
		return { state: "reconnecting", reason: "transport_unavailable" };
	return { state: "unavailable", reason: "verification_failed" };
}
export function recoveryMessage(status: RecoveryStatus): string {
	switch (status.state) {
		case "reconnecting":
			return "Connection interrupted. Waiting to reconnect.";
		case "browser_required":
			return "Open the service in your approved Chrome profile to reconnect.";
		case "sign_in_required":
			return "Your service session expired. Sign in to the approved account.";
		case "approval_required":
			return "Review the account and requested access to reconnect.";
		default:
			return "Connection unavailable. Retry verification or check local diagnostics.";
	}
}
export function recoveryDelay(attempt: number, retryAfterMs = 0, random = Math.random): number {
	const base = Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, attempt)));
	return Math.max(Math.min(60_000, base * (0.8 + random() * 0.2)), Math.max(0, retryAfterMs));
}
export class RecoveryError extends Error {
	constructor(
		readonly recovery: RecoveryStatus,
		readonly retryAfterMs = 0,
	) {
		super(recoveryMessage(recovery));
	}
}

export function recoveryFromResult(result: unknown): RecoveryError | undefined {
	const r = result as {
		isError?: boolean;
		structuredContent?: any;
		content?: Array<{ text?: string }>;
	};
	if (!r?.isError) return;
	let detail = r.structuredContent;
	if (!detail)
		for (const item of r.content ?? []) {
			try {
				detail = JSON.parse(item.text ?? "");
				break;
			} catch {}
		}
	const recovery = detail?.recovery;
	if (
		!recovery ||
		![
			"reconnecting",
			"browser_required",
			"sign_in_required",
			"approval_required",
			"unavailable",
		].includes(recovery.state)
	)
		return new RecoveryError(classifyRecovery(detail?.code ?? detail?.error));
	const ms = detail.retryAfterMs;
	return new RecoveryError(
		{
			state: recovery.state,
			reason: [
				"session_expired",
				"permission_required",
				"identity_mismatch",
				"approval_required",
				"browser_required",
				"rate_limited",
				"transport_unavailable",
				"verification_failed",
			].includes(recovery.reason)
				? recovery.reason
				: "verification_failed",
		},
		typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : 0,
	);
}
export function recoveryContent(error: unknown) {
	return error instanceof RecoveryError
		? { structuredContent: { recovery: error.recovery, retryAfterMs: error.retryAfterMs } }
		: {};
}
