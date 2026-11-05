import { browserEnabled } from "@repo/local-mcp-core/browser-catalog";
import { expect, it, vi } from "vitest";

it("activates only the accepted platforms and retains an explicit rollback switch", () => {
	vi.stubEnv("LAPLACE_TETHERED_BROWSER_V1", undefined);
	try {
		expect(browserEnabled("darwin", "arm64")).toBe(true);
		expect(browserEnabled("win32", "x64")).toBe(true);
		for (const [platform, arch] of [
			["darwin", "x64"],
			["linux", "x64"],
		]) {
			expect(browserEnabled(platform, arch)).toBe(false);
		}
		expect(browserEnabled("darwin", "arm64", "false")).toBe(false);
		expect(browserEnabled("darwin", "arm64", "invalid")).toBe(false);
		expect(browserEnabled("linux", "x64", "true")).toBe(true);
	} finally {
		vi.unstubAllEnvs();
	}
});
