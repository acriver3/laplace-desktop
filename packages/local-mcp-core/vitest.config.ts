import { defineConfig } from "vitest/config";

// Connector fixtures share machine-wide resource leases, so files run one at a time.
export default defineConfig({
	test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000, fileParallelism: false },
});
