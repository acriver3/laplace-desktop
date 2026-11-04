import { defineConfig } from "vitest/config";

export default defineConfig({
	oxc: { jsx: { runtime: "automatic" } },
	test: { include: ["tests/**/*.test.ts"], maxWorkers: 2, testTimeout: 15000 },
});
