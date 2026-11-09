import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});
it.each(["false", "true"])(
	"offers the npm Outlook release with session recovery %s",
	async (recovery) => {
		vi.stubEnv("LAPLACE_SESSION_RECOVERY_V1", recovery);
		vi.resetModules();
		const { legacyBundleCatalog, bundleAvailable } =
			await import("@repo/local-runtime/library-catalog");
		const entry = legacyBundleCatalog.find((x) => x.id === "msoutlook-mcp")!;
		expect(entry).toMatchObject({
			version: "0.5.0-laplace.2",
			npm: { package: "@withlaplace/msoutlook-mcp", distTag: "latest", bin: "msoutlook-mcp" },
		});
		expect(bundleAvailable(entry, "win32-x64")).toBe(true);
		expect(entry.acceptance.map((result) => result.version)).toEqual([
			"0.5.0-laplace.1",
			"0.5.0-laplace.1",
			"0.5.0-laplace.1",
		]);
	},
);
it("keeps legacy bundle installations of any version resolvable for migration", async () => {
	const { catalogEntryForConfig } = await import("@repo/local-runtime/library-catalog");
	for (const identity of ["msoutlook-mcp@0.5.0-laplace.1", "msoutlook-mcp@0.5.0-laplace.2"])
		expect(catalogEntryForConfig({ identity, cwd: "/bundle" })).toMatchObject({
			legacy: true,
			entry: { id: "msoutlook-mcp" },
		});
	expect(
		catalogEntryForConfig({
			identity: "npm:@withlaplace/msoutlook-mcp@0.5.0-laplace.3",
			npm: { package: "@withlaplace/msoutlook-mcp", version: "0.5.0-laplace.3" },
		}),
	).toMatchObject({ legacy: false, entry: { id: "msoutlook-mcp" } });
	// Desktop-shipped adapters never run from an extracted bundle directory.
	expect(catalogEntryForConfig({ identity: "msoutlook-mcp@0.6.0-candidate.9" })).toBeUndefined();
	expect(
		catalogEntryForConfig({
			identity: "msoutlook-mcp@0.6.0-candidate.9",
			cwd: "/bundle",
			managedBrowser: {},
		}),
	).toBeUndefined();
});
