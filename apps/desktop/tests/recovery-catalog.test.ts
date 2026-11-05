import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});
it("keeps the stable background bundle by default", async () => {
	vi.stubEnv("LAPLACE_SESSION_RECOVERY_V1", "false");
	vi.resetModules();
	const { legacyBundleCatalog, allBundleCatalog } = await import("@repo/local-runtime/library-catalog");
	expect(
		allBundleCatalog.some((x) => x.id === "msoutlook-mcp" && x.version === "0.5.0-laplace.2"),
	).toBe(true);
	expect(legacyBundleCatalog.find((x) => x.id === "msoutlook-mcp")?.version).toBe(
		"0.5.0-laplace.1",
	);
});
it("offers the recovery candidate only when opted in and retains historical installs", async () => {
	vi.stubEnv("LAPLACE_SESSION_RECOVERY_V1", "true");
	vi.resetModules();
	const { legacyBundleCatalog, allBundleCatalog, bundleAvailable } =
		await import("@repo/local-runtime/library-catalog");
	const entry = legacyBundleCatalog.find((x) => x.id === "msoutlook-mcp")!;
	expect(entry.version).toBe("0.5.0-laplace.2");
	expect(bundleAvailable(entry.artifacts[0]!)).toBe(true);
	expect(entry.artifacts[0]!.acceptance).toEqual([]);
	expect(allBundleCatalog.some((x) => x.id === entry.id && x.version === "0.5.0-laplace.1")).toBe(
		true,
	);
});
