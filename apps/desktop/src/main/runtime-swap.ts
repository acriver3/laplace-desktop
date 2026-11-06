import type { SwapResult } from "@repo/local-runtime/update";

/** Retry after errors sooner than after a busy runtime, which is expected to stay busy for a while. */
export const RUNTIME_SWAP_ERROR_RETRY = 60_000;
export const RUNTIME_SWAP_BUSY_RETRY = 300_000;

/**
 * When to try moving the running runtime onto the installed version again, or undefined when no
 * retry is needed. `undefined` input means the attempt threw; that must never strand the old runtime.
 */
export function runtimeSwapRetryDelay(result: SwapResult | undefined): number | undefined {
	if (!result) return RUNTIME_SWAP_ERROR_RETRY;
	if (result.swapped) return undefined;
	if (result.reason === "busy" || result.reason === "not-stopped") return RUNTIME_SWAP_BUSY_RETRY;
	// current / not-running / stopped need nothing; restored means the new version failed its
	// health check and the previous one is running again, so it is not retried automatically.
	return undefined;
}
