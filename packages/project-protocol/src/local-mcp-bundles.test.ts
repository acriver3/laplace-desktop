import { describe, expect, it } from "vitest";

import {
	bundleAcceptanceComplete,
	bundleAvailable,
	bundleCatalog,
	bundleCatalogSchema,
	bundleDownloadPath,
	bundleMatches,
	bundleSetupPrompt,
	existingMcpSetupPrompt,
	findBundleArtifact,
	githubMcpInput,
	githubMcpSetupPrompt,
	verifiedBundlePlatforms,
} from "./local-mcp-bundles";

const origin = "https://connect.withlaplace.com";
describe("local MCP bundle catalog", () => {
	it("rejects duplicate bundle versions, artifact names and platform declarations", () => {
		expect(bundleCatalogSchema.safeParse([bundleCatalog[0], bundleCatalog[0]]).success).toBe(false);
		const entry = structuredClone(bundleCatalog[0]!);
		entry.artifacts.push(entry.artifacts[0]!);
		expect(bundleCatalogSchema.safeParse([entry]).success).toBe(false);
		entry.artifacts.pop();
		entry.artifacts[0]!.platforms.push(entry.artifacts[0]!.platforms[0]!);
		expect(bundleCatalogSchema.safeParse([entry]).success).toBe(false);
	});
	it("identifies pinned sources and does not claim unrecorded platform acceptance", () => {
		expect(bundleCatalog.map((entry) => entry.name)).toEqual([
			"Canvas [Background Browser]",
			"LinkedIn",
			"Yale SOM EMS [Background Browser]",
			"Outlook",
		]);
		expect(new Set(bundleCatalog.map((entry) => entry.id)).size).toBe(bundleCatalog.length);
		for (const entry of bundleCatalog)
			for (const artifact of entry.artifacts) {
				expect(findBundleArtifact(entry.id, entry.version, artifact.name)).toEqual({
					entry,
					artifact,
				});
				expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
				expect(bundleDownloadPath(entry, artifact)).toContain(
					`/bundles/${entry.id}/${entry.version}/`,
				);
				for (const platform of verifiedBundlePlatforms(artifact))
					expect(
						artifact.acceptance.some(
							(result) => result.platform === platform && result.archiveSha256 === artifact.sha256,
						),
					).toBe(true);
			}
		expect(findBundleArtifact("../canvas-session-mcp", "latest", "source.zip")).toBeUndefined();
	});
	it("invalidates acceptance after an artifact changes and requires publication too", () => {
		const artifact = structuredClone(bundleCatalog[0]!.artifacts[0]!);
		artifact.acceptance = artifact.platforms.map((platform) => ({
			platform,
			archiveSha256: artifact.sha256,
			acceptedAt: "2026-10-09T12:00:00Z",
			evidence: "fixture-only",
		}));
		expect(bundleAcceptanceComplete(artifact)).toBe(true);
		artifact.published = false;
		expect(bundleAvailable(artifact)).toBe(false);
		artifact.published = true;
		expect(bundleAvailable(artifact)).toBe(true);
		artifact.sha256 = "b".repeat(64);
		expect(verifiedBundlePlatforms(artifact)).toEqual([]);
		expect(bundleAvailable(artifact)).toBe(false);
	});
	it("searches capabilities, license and project names", () => {
		expect(bundleMatches(bundleCatalog[0]!, " COURSE FILES ")).toBe(true);
		expect(bundleMatches(bundleCatalog[1]!, "apache")).toBe(true);
		expect(bundleMatches(bundleCatalog[0]!, "missing connector")).toBe(false);
	});
	it.each(bundleCatalog)("creates a pinned, local bundle setup prompt for $name", (entry) => {
		const artifact = entry.artifacts[0]!;
		const prompt = bundleSetupPrompt(entry, artifact, origin);
		expect(prompt).toContain(`${origin}${bundleDownloadPath(entry, artifact)}`);
		expect(prompt).toContain(artifact.sha256);
		expect(prompt).toContain(entry.upstreamCommit);
		expect(prompt).toContain("server.mcp_config");
		expect(prompt).toContain("user_config");
		expect(prompt).toContain("outside");
		expect(prompt).toContain("laplace_local_status");
		expect(prompt).not.toMatch(/C:\\Users|yale\.instructure|@latest|mcp-server-linkedin==/i);
		if (entry.recipe === "canvas" || entry.recipe === "outlook")
			expect(prompt).toContain("do not run npm install");
		else if (entry.recipe === "linkedin")
			expect(prompt).toContain("uv sync --locked --no-dev --python 3.13");
		else {
			expect(prompt).toContain("ems_session_status");
			expect(prompt).toContain("ems_list_templates");
			expect(prompt).toContain("Yale SSO/MFA");
			expect(prompt).not.toContain("uv sync");
		}
	});
	it("keeps an unaccepted Outlook candidate unavailable", () => {
		const entry = bundleCatalog.find((entry) => entry.recipe === "outlook")!;
		const artifact = structuredClone(entry.artifacts[0]!);
		artifact.acceptance = [];
		artifact.published = false;
		expect(bundleAvailable(artifact)).toBe(false);
		expect(verifiedBundlePlatforms(artifact)).toEqual([]);
		const prompt = bundleSetupPrompt(entry, artifact, origin);
		expect(prompt).toContain("outlook_login");
		expect(prompt).toContain("outlook_list_folders");
		expect(prompt).toContain("MSOUTLOOK_SKIP_COOKIE_IMPORT=false");
		expect(prompt).toContain("Select the server ID outlook");
		expect(prompt).not.toContain("LinkedIn:");
	});
	it("guides existing local imports without modifying the original settings", () => {
		const prompt = existingMcpSetupPrompt(origin);
		expect(prompt).toContain("Codex TOML");
		expect(prompt).toContain("normalize");
		expect(prompt).toContain("do not upload configurations");
		expect(prompt).toContain("HTTP servers stay independently owned");
		expect(prompt).toContain("reuse the chosen connection");
	});
	it("keeps EMS unavailable while acceptance is pending and validates source directories", () => {
		const entry = bundleCatalog.find((entry) => entry.recipe === "yale-som-ems")!;
		const pending = structuredClone(entry.artifacts[0]!);
		pending.published = false;
		pending.acceptance = [
			{
				platform: "win32-x64",
				archiveSha256: pending.sha256,
				acceptedAt: "2026-10-10T02:28:21Z",
				evidence: "Partial acceptance fixture",
			},
		];
		expect(verifiedBundlePlatforms(pending)).toEqual(["win32-x64"]);
		expect(bundleAcceptanceComplete(pending)).toBe(false);
		expect(bundleAvailable(pending)).toBe(false);
		for (const path of [
			"../private",
			"/private",
			"apps/../private",
			"C:/private",
			"apps\\private",
			"apps/./server",
		]) {
			expect(bundleCatalogSchema.safeParse([{ ...entry, sourceSubdirectory: path }]).success).toBe(
				false,
			);
		}
		expect(
			bundleCatalogSchema.safeParse([{ ...entry, sourceSubdirectory: "apps/yale-som-ems-mcp" }])
				.success,
		).toBe(true);
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
		{ repository: "https://github.com/example/mcp", ref: "--upload-pack=other", subdirectory: "" },
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
