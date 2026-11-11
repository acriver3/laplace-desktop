import { describe, expect, it } from "vitest";

import {
	bundleAcceptanceComplete,
	bundleAvailable,
	bundleAvailablePlatforms,
	bundleCatalog,
	bundleCatalogSchema,
	bundleConfigurationKeys,
	bundleMatches,
	bundleNpmSpec,
	bundlePlatformAvailable,
	bundleSetupPrompt,
	existingMcpSetupPrompt,
	githubMcpInput,
	githubMcpSetupPrompt,
	verifiedBundlePlatforms,
} from "./local-mcp-bundles";

const origin = "https://connect.withlaplace.com";
describe("local MCP bundle catalog", () => {
	it("rejects duplicate versions and platforms, and non-npm versions", () => {
		expect(bundleCatalogSchema.safeParse([bundleCatalog[0], bundleCatalog[0]]).success).toBe(false);
		const entry = structuredClone(bundleCatalog[0]!);
		entry.platforms.push(entry.platforms[0]!);
		expect(bundleCatalogSchema.safeParse([entry]).success).toBe(false);
		expect(
			bundleCatalogSchema.safeParse([{ ...bundleCatalog[0]!, version: "latest" }]).success,
		).toBe(false);
	});
	it("names exact @withlaplace npm packages and only supported placeholders", () => {
		expect(bundleCatalog.map((entry) => entry.name)).toEqual([
			"Canvas [Background Browser]",
			"LinkedIn [Background Browser]",
			"Yale SOM EMS [Background Browser]",
			"Yale SOM CMS [Background Browser]",
			"Outlook",
		]);
		expect(new Set(bundleCatalog.map((entry) => entry.id)).size).toBe(bundleCatalog.length);
		for (const entry of bundleCatalog) {
			expect(entry.npm.package).toBe(`@withlaplace/${entry.id}`);
			expect(entry.npm.distTag).toBe("latest");
			expect(bundleNpmSpec(entry)).toBe(`@withlaplace/${entry.id}@${entry.version}`);
			expect(JSON.stringify(entry)).not.toMatch(/sha256|archiveSha256|storagePrefix|\.mcpb/);
			for (const platform of verifiedBundlePlatforms(entry))
				expect(entry.acceptance.some((result) => result.platform === platform)).toBe(true);
		}
		const ems = bundleCatalog.find((entry) => entry.recipe === "yale-som-ems")!;
		expect(ems).toMatchObject({
			version: "0.1.2",
			repository: "https://github.com/acriver3/laplace-mcp-library",
			sourceDirectory: "connectors/yale-som-ems-mcp",
			npm: {
				bin: "yale-som-ems-mcp",
				args: [
					"serve",
					"--profile-dir",
					"${user_config.profile_dir}",
					"--browser",
					"${user_config.browser}",
				],
				env: {},
			},
		});
		expect(bundleConfigurationKeys(ems)).toEqual(["profile_dir", "browser"]);
		for (const value of ["${HOME}", "${__dirname}/x", "${user_config.Upper}", "a\0b"])
			expect(
				bundleCatalogSchema.safeParse([{ ...ems, npm: { ...ems.npm, args: [value] } }]).success,
			).toBe(false);
		for (const distTag of ["1.0.0", "v1", "^1.0.0", ""])
			expect(
				bundleCatalogSchema.safeParse([{ ...ems, npm: { ...ems.npm, distTag } }]).success,
			).toBe(false);
		expect(
			bundleCatalogSchema.safeParse([{ ...ems, npm: { ...ems.npm, package: "yale-som-ems-mcp" } }])
				.success,
		).toBe(false);
	});
	it("declares CMS local directories and requires publication before availability", () => {
		const cms = bundleCatalog.find((entry) => entry.recipe === "yale-som-cms")!;
		expect(cms).toMatchObject({
			version: "0.1.0",
			platforms: ["win32-x64"],
		});
		expect(bundleConfigurationKeys(cms)).toEqual(["profile_dir", "browser", "downloads_dir"]);
		expect(bundleAvailable({ ...cms, published: false })).toBe(false);
		expect(bundleNpmSpec(cms)).toBe("@withlaplace/yale-som-cms-mcp@0.1.0");
	});
	it("offers a platform only when published, declared and accepted there or a candidate", () => {
		const entry = structuredClone(bundleCatalog.find((item) => item.recipe === "yale-som-ems")!);
		expect(bundleAvailablePlatforms(entry)).toEqual(["win32-x64", "darwin-arm64"]);
		expect(bundlePlatformAvailable(entry, "darwin-x64")).toBe(false);
		expect(bundleAvailable(entry)).toBe(true);
		expect(bundleAcceptanceComplete(entry)).toBe(true);
		entry.published = false;
		expect(bundleAvailable(entry)).toBe(false);
		expect(bundleAvailable(entry, "win32-x64")).toBe(false);
		entry.published = true;
		entry.acceptance = entry.acceptance.filter((result) => result.platform === "win32-x64");
		expect(verifiedBundlePlatforms(entry)).toEqual(["win32-x64"]);
		expect(bundleAcceptanceComplete(entry)).toBe(false);
		expect(bundleAvailable(entry, "win32-x64")).toBe(true);
		expect(bundleAvailable(entry, "darwin-arm64")).toBe(false);
		entry.candidate = true;
		expect(bundleAvailable(entry, "darwin-arm64")).toBe(true);
		expect(bundleAvailable(entry, "linux-x64")).toBe(false);
		// Acceptance for an undeclared platform never makes it available.
		entry.acceptance.push({ ...entry.acceptance[0]!, platform: "linux-x64" });
		entry.candidate = false;
		expect(bundleAvailable(entry, "linux-x64")).toBe(false);
	});
	it("carries earlier acceptance records with the version that was accepted", () => {
		const canvas = bundleCatalog.find((entry) => entry.recipe === "canvas")!;
		expect(canvas.version).toBe("0.1.0-laplace.2");
		expect(canvas.acceptance.map((result) => result.version)).toEqual([
			"0.1.0-laplace.1",
			"0.1.0-laplace.1",
			"0.1.0-laplace.1",
		]);
		for (const entry of bundleCatalog)
			for (const result of entry.acceptance)
				expect(result.evidence).not.toMatch(/exact (checksum|artifact|bundle)/);
	});
	it("searches capabilities, license and project names", () => {
		expect(bundleMatches(bundleCatalog[0]!, " COURSE FILES ")).toBe(true);
		expect(bundleMatches(bundleCatalog[1]!, "apache")).toBe(true);
		expect(bundleMatches(bundleCatalog[0]!, "missing connector")).toBe(false);
	});
	it.each(bundleCatalog)("creates an exact-version npm setup prompt for $name", (entry) => {
		const prompt = bundleSetupPrompt(entry, origin);
		expect(prompt).toContain(
			`npm install --ignore-scripts --prefix <that directory> ${entry.npm.package}@${entry.version}`,
		);
		expect(prompt).toContain("use this exact package and version");
		expect(prompt).toContain(entry.npm.bin);
		expect(prompt).toContain("user_config");
		expect(prompt).toContain("${package_dir}");
		expect(prompt).toContain("outside");
		expect(prompt).toContain("laplace_local_status");
		expect(prompt).not.toMatch(/SHA-256|\bsize\b|\.mcpb|server\.mcp_config|bundle manifest/i);
		expect(prompt).not.toMatch(/C:\\Users|yale\.instructure|@latest|mcp-server-linkedin==/i);
		if (entry.recipe === "linkedin") {
			expect(prompt).toContain("uv sync --locked --no-dev --python 3.13");
			expect(prompt).toContain("LAPLACE_UV");
		} else if (entry.recipe === "yale-som-ems") {
			expect(prompt).toContain("serve --profile-dir ${user_config.profile_dir}");
			expect(prompt).toContain("ems_session_status");
			expect(prompt).toContain("ems_list_templates");
			expect(prompt).toContain("Yale SSO/MFA");
			expect(prompt).not.toContain("uv sync");
		} else if (entry.recipe === "yale-som-cms") {
			expect(prompt).toContain("https://som-yale.12twenty.com/dashboard/");
			expect(prompt).toContain("cms_session_status");
			expect(prompt).toContain("cms_get_dashboard");
			expect(prompt).toContain("--downloads-dir");
			expect(prompt).toContain("Yale SSO/MFA");
			expect(prompt).not.toContain("uv sync");
		} else if (entry.recipe === "outlook") {
			expect(prompt).toContain("outlook_login");
			expect(prompt).toContain("outlook_list_folders");
			expect(prompt).toContain("MSOUTLOOK_SKIP_COOKIE_IMPORT=false");
			expect(prompt).toContain("Select the server ID outlook");
			expect(prompt).not.toContain("LinkedIn:");
		} else expect(prompt).toContain("CANVAS_URL=${user_config.canvas_url}");
	});
	it("tells agents to stop when an unpublished version is unavailable", () => {
		const entry = structuredClone(bundleCatalog.find((item) => item.recipe === "outlook")!);
		entry.acceptance = [];
		entry.published = false;
		expect(bundleAvailable(entry)).toBe(false);
		const prompt = bundleSetupPrompt(entry, origin);
		expect(prompt).toContain("acceptance pending");
		expect(prompt).toContain("stop if npm does not have it");
	});
	it("guides existing local imports without modifying the original settings", () => {
		const prompt = existingMcpSetupPrompt(origin);
		expect(prompt).toContain("Codex TOML");
		expect(prompt).toContain("normalize");
		expect(prompt).toContain("do not upload configurations");
		expect(prompt).toContain("HTTP servers stay independently owned");
		expect(prompt).toContain("reuse the chosen connection");
	});
	it("validates informational source directories", () => {
		const entry = bundleCatalog.find((entry) => entry.recipe === "yale-som-ems")!;
		for (const path of [
			"../private",
			"/private",
			"apps/../private",
			"C:/private",
			"apps\\private",
			"apps/./server",
		])
			for (const key of ["sourceSubdirectory", "sourceDirectory"])
				expect(bundleCatalogSchema.safeParse([{ ...entry, [key]: path }]).success).toBe(false);
		expect(
			bundleCatalogSchema.safeParse([{ ...entry, sourceSubdirectory: "apps/yale-som-ems-mcp" }])
				.success,
		).toBe(true);
		const { upstreamCommit: _, ...withoutCommit } = entry;
		expect(bundleCatalogSchema.safeParse([withoutCommit]).success).toBe(true);
	});
});

describe("GitHub MCP setup", () => {
	it("pins default branches or requested refs and supports project subdirectories", () => {
		const prompt = githubMcpSetupPrompt(
			{
				repository: "https://github.com/example/private-mcp",
				ref: "release/v1",
				subdirectory: "packages/server",
			},
			origin,
		);
		expect(prompt).toContain("release/v1");
		expect(prompt).toContain("packages/server");
		expect(prompt).toContain("full commit SHA before installation");
		expect(prompt).toContain("authorized local Git credentials");
		expect(prompt).toContain("user-added and is not Laplace-vetted");
		expect(
			githubMcpSetupPrompt(
				{ repository: "https://github.com/example/mcp", ref: "", subdirectory: "" },
				origin,
			),
		).toContain("the repository's default branch");
	});
	it.each([
		{ repository: "", ref: "", subdirectory: "" },
		{ repository: "not a URL", ref: "", subdirectory: "" },
		{ repository: "https://token@github.com/example/mcp", ref: "", subdirectory: "" },
		{ repository: "https://github.com/example/mcp?token=private", ref: "", subdirectory: "" },
		{ repository: "https://github.com/example/mcp/tree/main", ref: "", subdirectory: "" },
		{ repository: "https://other.example/example/mcp", ref: "", subdirectory: "" },
		{
			repository: "https://github.com/example/mcp",
			ref: "--upload-pack=other",
			subdirectory: "",
		},
		{
			repository: "https://github.com/example/mcp",
			ref: "main\nnew instructions",
			subdirectory: "",
		},
		{ repository: "https://github.com/example/mcp", ref: "", subdirectory: "../private" },
		{ repository: "https://github.com/example/mcp", ref: "", subdirectory: "C:\\private" },
	])("rejects credential-bearing URLs and invalid project selectors: %j", (input) => {
		expect(githubMcpInput.safeParse(input).success).toBe(false);
	});
});
