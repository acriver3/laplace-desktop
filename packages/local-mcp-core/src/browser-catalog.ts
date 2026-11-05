import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join, resolve } from "node:path";

import { browserProviders, type BrowserProviderId } from "@repo/browser-runtime/browser-approval";
import { slackWorkspace } from "@repo/browser-runtime/slack-browser";
import {
	localConnectorMetadata,
	localConnectorSetupPrompt,
} from "@repo/project-protocol/local-mcp-setup";
import { z } from "zod";

import { serverConfig, type ServerConfig } from "./config";
import { verifyConnectorIndex } from "./connector-releases";
import { connectorSigningKey } from "./connector-releases";
import { readRetainedRuntime } from "./retained-runtime";
export const slackSettings = [
	"SLACK_MCP_ADD_MESSAGE_TOOL",
	"SLACK_MCP_REACTION_TOOL",
	"SLACK_MCP_ATTACHMENT_TOOL",
	"SLACK_MCP_ENABLED_TOOLS",
	"SLACK_MCP_ADD_MESSAGE_MARK",
	"SLACK_MCP_ADD_MESSAGE_UNFURLING",
	"SLACK_MCP_MARK_TOOL",
	"SLACK_MCP_MIN_REFRESH_INTERVAL",
	"SLACK_MCP_CACHE_TTL",
	"SLACK_MCP_GOVSLACK",
];
// Release qualification is platform-specific. An explicit false remains the rollback switch.
// Windows x64 and macOS ARM64 use the bundled tethered runtime.
export function browserEnabled(
	platform: string = process.platform,
	arch: string = process.arch,
	override = process.env.LAPLACE_TETHERED_BROWSER_V1,
) {
	if (override !== undefined) return override === "true";
	return (platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64");
}
export const browserSetupTools = ["pair", "status", "review", "authorize", "focus", "revoke"].map(
	(action) => "laplace_browser_" + action,
);
const artifactSchema = z
	.object({
		catalogId: z.enum(["ycombinator-demo", "msoutlook-mcp", "slack-mcp-server"]),
		provider: z.enum(["ycombinator", "outlook", "slack", "slack-tethered"]),
		version: z.string().min(1).max(100),
		serverId: z.string().min(1).max(80),
		workspace: z.string().url(),
		file: z.string().regex(/^helper\/[a-z-]+\.cjs$/),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export async function browserArtifacts(resources: string) {
	return z
		.array(artifactSchema)
		.parse(JSON.parse(await readFile(join(resources, "browser-connectors.json"), "utf8")));
}
export async function browserConfiguration(
	resources: string,
	catalogId: string,
	workspace?: string,
) {
	if (!browserEnabled()) throw Error("Tethered browser connectors are not activated.");
	const artifact = (await browserArtifacts(resources)).find((a) => a.catalogId === catalogId);
	if (!artifact)
		throw Error("This connector has no verified tethered artifact in this installation.");
	if (artifact.provider === "slack" || artifact.provider === "slack-tethered")
		workspace = slackWorkspace(workspace ?? artifact.workspace);
	else if (workspace && workspace !== artifact.workspace)
		throw Error("This connector has a fixed browser workspace.");
	const file = resolve(resources, artifact.file);
	if (
		createHash("sha256")
			.update(await readFile(file))
			.digest("hex") !== artifact.sha256
	)
		throw Error("Browser connector artifact failed its integrity check.");
	const metadata = localConnectorMetadata(catalogId, true);
	return serverConfig.parse({
		id: artifact.serverId,
		name: metadata.name,
		transport: "stdio",
		command: "node",
		args: [file],
		identity: `${catalogId}@${artifact.version}`,
		enabled: true,
		env: {
			LAPLACE_TETHERED_BROWSER_V1: "true",
			LAPLACE_BROWSER_WORKSPACE: workspace ?? artifact.workspace,
		},
		managedBrowser: {
			catalogId,
			provider: artifact.provider,
			workspace: workspace ?? artifact.workspace,
			artifactSha256: artifact.sha256,
			runtimeVersion: artifact.version,
		},
	});
}
export async function verifyBrowserConfiguration(resources: string, config: ServerConfig) {
	const receipt = config.managedBrowser;
	if (!receipt || config.transport !== "stdio")
		throw Error("Explicit managed migration is required for this imported connection.");
	const expected = await browserConfiguration(resources, receipt.catalogId, receipt.workspace);
	if (
		expected.transport === "stdio" &&
		JSON.stringify(config.args) !== JSON.stringify(expected.args)
	) {
		// Independently released tethered entries carry the signed catalog, never a remote launch command.
		const entryPath = config.args[0];
		if (!entryPath || config.args.length !== 1) throw Error("Invalid managed connector entry");
		const directory = dirname(entryPath);
		let retained;
		try {
			retained = await readRetainedRuntime(entryPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (retained) {
			if (
				retained.catalogId !== receipt.catalogId ||
				retained.provider !== receipt.provider ||
				retained.version !== receipt.runtimeVersion ||
				retained.artifactSha256 !== receipt.artifactSha256
			)
				throw Error("Retained connector receipt mismatch");
			expected.args = [entryPath];
			expected.identity = `${receipt.catalogId}@${receipt.runtimeVersion}`;
			expected.managedBrowser = {
				...expected.managedBrowser!,
				runtimeVersion: receipt.runtimeVersion,
				artifactSha256: receipt.artifactSha256,
			};
		} else {
			const proof = JSON.parse(await readFile(join(directory, ".laplace-release.json"), "utf8"));
			const index = verifyConnectorIndex(
				Buffer.from(proof.payload, "base64"),
				Buffer.from(proof.signature, "base64"),
				connectorSigningKey,
			);
			const release = index.releases.find(
				(r) =>
					r.id === receipt.catalogId &&
					r.version === receipt.runtimeVersion &&
					r.mode === "tethered" &&
					r.platforms.includes(`${process.platform}-${process.arch}` as never),
			);
			if (
				!release ||
				release.permissionRevision !==
					browserProviders[receipt.provider as BrowserProviderId]?.revision.toString()
			)
				throw Error("Connector permission revision requires approval");
			const entry = release.files.find((file) => join(directory, file.path) === entryPath);
			if (!entry || entry.sha256 !== receipt.artifactSha256)
				throw Error("Managed connector receipt mismatch");
			for (const file of release.files) {
				const bytes = await readFile(join(directory, file.path));
				if (
					bytes.length !== file.size ||
					createHash("sha256").update(bytes).digest("hex") !== file.sha256
				)
					throw Error("Managed connector artifact changed");
			}
			expected.args = [entryPath];
			expected.identity = `${receipt.catalogId}@${release.version}`;
			expected.managedBrowser = {
				...expected.managedBrowser!,
				runtimeVersion: release.version,
				artifactSha256: entry.sha256,
			};
		}
	}

	if (
		expected.transport !== "stdio" ||
		config.command !== expected.command ||
		JSON.stringify(config.args) !== JSON.stringify(expected.args) ||
		config.identity !== expected.identity ||
		JSON.stringify(
			Object.fromEntries(
				Object.entries(config.env).filter(
					([key]) => !(receipt.provider === "slack-tethered" && slackSettings.includes(key)),
				),
			),
		) !== JSON.stringify(expected.env) ||
		JSON.stringify(receipt) !== JSON.stringify(expected.managedBrowser)
	)
		throw Error(
			"Managed browser configuration changed; repair or explicitly migrate it before setup.",
		);
	if (!Object.hasOwn(browserProviders, receipt.provider))
		throw Error("Browser provider is not activated in this runtime.");
	return receipt as typeof receipt & { provider: BrowserProviderId };
}
export async function browserCatalog(resources: string) {
	if (!browserEnabled()) return [];
	return (await browserArtifacts(resources)).map((entry) => {
		const metadata = localConnectorMetadata(entry.catalogId, true);
		return {
			id: entry.catalogId,
			...metadata,
			instructions: localConnectorSetupPrompt({ id: entry.catalogId, name: metadata.name }),
		};
	});
}
