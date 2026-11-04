import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	catalogConfiguration,
	extractBundle,
	resolveManifestConfiguration,
	downloadBundle,
} from "../src/helper/catalog";
import { bundleCatalog } from "../src/helper/library-catalog";

async function verify(directory: string) {
	const temporary = await mkdtemp(join(tmpdir(), "laplace-catalog-static-"));
	try {
		for (const entry of bundleCatalog) {
			// Slack ships inside Desktop and is covered by extension/MCP smoke tests.
			if (entry.recipe === "slack-ready") continue;
			for (const artifact of entry.artifacts.filter((item) => item.published)) {
				const bytes = directory
					? await readFile(join(directory, artifact.name))
					: await downloadBundle(artifact.url, artifact, new AbortController().signal);
				assert.equal(bytes.length, artifact.size);
				assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
				const extracted = join(temporary, artifact.name);
				await extractBundle(bytes, extracted);
				const manifest = JSON.parse(await readFile(join(extracted, "manifest.json"), "utf8"));
				const configuration = catalogConfiguration(
					entry,
					entry.recipe === "canvas" ? { canvas_url: "https://canvas.fixture.invalid" } : {},
					join(temporary, "state"),
					extracted,
				);
				const resolved = resolveManifestConfiguration(manifest, entry, extracted, configuration);
				assert.equal(resolved.enabled, false);
				assert.ok(!JSON.stringify(resolved).includes("${"));
				await access(join(extracted, manifest.server.entry_point));
				if (entry.recipe === "canvas") {
					const source = await readFile(join(extracted, "bin/cli.js"), "utf8");
					assert.match(source, /cmd === 'login'/);
					assert.match(source, /url: \{ type: 'string' \}/);
					for (const name of [
						"CANVAS_URL",
						"CANVAS_MCP_HOME",
						"CANVAS_MCP_DOWNLOADS",
						"CANVAS_MCP_BROWSER",
					])
						assert.ok(name in manifest.server.mcp_config.env);
				} else if (entry.recipe === "linkedin") {
					const source = await readFile(
						join(extracted, "linkedin_mcp_server/config/loaders.py"),
						"utf8",
					);
					for (const option of ["--login", "--auto-import", "--no-daemon", "--user-data-dir"])
						assert.ok(source.includes(`"${option}"`));
					assert.match(
						await readFile(join(extracted, "linkedin_mcp_server/cli_main.py"), "utf8"),
						/ensure_browser_installed\(\)/,
					);
					await access(join(extracted, "uv.lock"));
				} else if (entry.recipe === "yale-som-ems") {
					const source = await readFile(join(extracted, "src/cli.ts"), "utf8");
					for (const option of ["profile-dir", "browser"]) assert.ok(source.includes(option));
					assert.match(source, /command === "login"/);
				} else {
					const source = await readFile(join(extracted, "src/tools/auth-tools.ts"), "utf8");
					assert.match(source, /'outlook_login'/);
					assert.match(source, /force_new \?\? false/);
					assert.equal(manifest.server.mcp_config.env.MSOUTLOOK_SKIP_COOKIE_IMPORT, "false");
				}
				console.log(
					JSON.stringify({
						id: entry.id,
						version: entry.version,
						sha256: artifact.sha256,
						size: bytes.length,
						safeExtraction: "passed",
						manifestResolution: "passed",
						setupSourceContract: "passed",
						connectorExecuted: false,
					}),
				);
			}
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
void verify(process.argv[2]!).catch((error) => {
	console.error(error instanceof Error ? error.message : "Catalog verification failed");
	process.exitCode = 1;
});
