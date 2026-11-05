import { browserEnabled } from "@repo/local-mcp-core/browser-catalog";
import { expect, it, vi } from "vitest";

it("activates only the accepted platform and retains an explicit rollback switch", () => {
	vi.stubEnv("LAPLACE_TETHERED_BROWSER_V1", undefined);
	try {
		expect(browserEnabled("darwin", "arm64")).toBe(true);
		expect(browserEnabled("win32", "x64")).toBe(true);
		for (const [platform, arch] of [
			["darwin", "x64"],
			["win32", "arm64"],
			["linux", "x64"],
		]) {
			expect(browserEnabled(platform, arch)).toBe(false);
		}
		expect(browserEnabled("darwin", "arm64", "false")).toBe(false);
		expect(browserEnabled("win32", "x64", "false")).toBe(false);
		expect(browserEnabled("darwin", "arm64", "invalid")).toBe(false);
		expect(browserEnabled("linux", "x64", "true")).toBe(true);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("offers the bundled tethered Outlook runtime on Windows without an environment override", async () => {
	vi.stubEnv("LAPLACE_TETHERED_BROWSER_V1", undefined);
	vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
	vi.resetModules();
	try {
		const { bundleCatalog, tetheredEntry } = await import("@repo/local-runtime/library-catalog");
		const outlook = bundleCatalog.find((entry) => entry.id === "msoutlook-mcp")!;
		expect(outlook.name).toBe("Outlook [Tethered]");
		expect(outlook.browserMode).toBe("tethered");
		expect(tetheredEntry(outlook)).toBe(true);
		expect(outlook.version).not.toBe("0.5.0-laplace.1");
	} finally {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.resetModules();
	}
});
