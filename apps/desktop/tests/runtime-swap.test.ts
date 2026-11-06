import { expect, test } from "vitest";

import {
	RUNTIME_SWAP_BUSY_RETRY,
	RUNTIME_SWAP_ERROR_RETRY,
	runtimeSwapRetryDelay,
} from "../src/main/runtime-swap";

test("a failed runtime swap is retried instead of leaving the old runtime running", () => {
	expect(runtimeSwapRetryDelay(undefined)).toBe(RUNTIME_SWAP_ERROR_RETRY);
	expect(runtimeSwapRetryDelay({ swapped: false, reason: "busy" })).toBe(RUNTIME_SWAP_BUSY_RETRY);
	expect(runtimeSwapRetryDelay({ swapped: false, reason: "not-stopped" })).toBe(
		RUNTIME_SWAP_BUSY_RETRY,
	);
	expect(RUNTIME_SWAP_ERROR_RETRY).toBeLessThan(RUNTIME_SWAP_BUSY_RETRY);
});

test("finished, unnecessary, or rolled-back swaps are not retried", () => {
	expect(runtimeSwapRetryDelay({ swapped: true, from: "0.1.30", to: "0.1.32" })).toBeUndefined();
	for (const reason of ["current", "not-running", "stopped"] as const)
		expect(runtimeSwapRetryDelay({ swapped: false, reason })).toBeUndefined();
	expect(
		runtimeSwapRetryDelay({
			swapped: false,
			reason: "restored",
			from: "0.1.30",
			to: "0.1.32",
			error: "Updated runtime reported another version",
		}),
	).toBeUndefined();
});
