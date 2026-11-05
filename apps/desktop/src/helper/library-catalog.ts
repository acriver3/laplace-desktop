import outlookArtifact from "@repo/browser-runtime/assets/outlook.json";
import slackArtifact from "@repo/browser-runtime/assets/slack.json";
import { browserEnabled } from "@repo/local-mcp-core/browser-catalog";
import {
	bundleEntrySchema,
	bundleArtifactSchema,
	bundleAvailable as acceptedBundle,
} from "@repo/project-protocol/local-mcp-bundles";
import { localConnectorMetadata } from "@repo/project-protocol/local-mcp-setup";
import { z } from "zod";

import { browserConnectionsEnabled } from "../shared/browser-feature";
import { slackBrowserVersion } from "../shared/slack-browser";
import { ycBrowserVersion } from "../shared/yc-browser";
import snapshot from "./library-catalog.json";

// Reviewed library snapshot; downloads never follow a moving branch or accept remote launch settings.
export const libraryRevision = "fa29103099f9f735da1b9c0ac10410ebda816249";
const artifactSchema = bundleArtifactSchema
	.extend({
		storagePrefix: z.string().default("library"),
		size: z
			.number()
			.int()
			.positive()
			.max(64 * 1024 * 1024),
		candidate: z.boolean().optional(),
		url: z
			.string()
			.url()
			.refine(
				(url) =>
					url.startsWith(
						`https://raw.githubusercontent.com/acriver3/laplace-mcp-library/${libraryRevision}/bundles/`,
					) &&
					!url.includes("..") &&
					!/[?#]/.test(url),
			),
	})
	.strip();
const entrySchema = bundleEntrySchema
	.extend({
		recipe: z.enum(["canvas", "linkedin", "yale-som-ems", "outlook", "slack-ready", "yc-demo"]),
		demoOnly: z.boolean().optional(),
		setupUrl: z.string().url(),
		browserMode: z.enum(["tethered", "background-browser"]),
		artifacts: z.array(artifactSchema),
	})
	.strip();
export type BundleCatalogEntry = z.infer<typeof entrySchema>;
export type BundleArtifact = z.infer<typeof artifactSchema>;
const legacyCatalogEntry = (item: (typeof snapshot)[number], browserPreview: boolean) =>
	entrySchema.parse({
		...item,
		...localConnectorMetadata(item.id),
		...(item.recipe === "slack-ready"
			? {
					description:
						"Preview: connect Slack with a dedicated browser login. Native platform acceptance is pending.",
					capabilities: ["Read channels and conversations", "Search messages"],
					upstreamVersion: item.version,
					patches: [],
					reviewedAt: "2026-10-29",
					authentication: [
						"Complete Slack sign-in and MFA in the dedicated browser. Chromium downloads on first login.",
					],
				}
			: {}),
		...(browserPreview && item.recipe === "slack-ready"
			? {
					...localConnectorMetadata(item.id, true),
					description:
						"Read Slack through a user-approved Laplace extension in your existing browser. No separate browser or session import.",
					version: slackBrowserVersion,
					artifacts: [],
					prerequisites: [
						"Existing signed-in Chrome or Edge tab",
						"User-approved Laplace Browser Connection extension",
					],
					reviewEvidence: ["apps/desktop/browser-extension/README.md"],
					reviewNotes: [
						"Desktop-shipped extension-only adapter. Legacy browser bundles are not downloaded or executed.",
					],
					capabilities: ["Read channels and conversations", "Search messages"],
					upstreamVersion: item.version,
					patches: [],
					reviewedAt: "2026-10-29",
					authentication: [
						"Sign in to Slack normally in your existing Chrome or Edge tab. Install the bundled Laplace Browser Connection extension with your approval, then select the pending request discovered automatically from local_connectors_authenticate and approve read-only access to that tab. No pairing code needs to be copied. Keep the tab open. No cookies are copied and no Chromium instance is launched.",
					],
				}
			: {}),
		repository:
			browserPreview && item.recipe === "slack-ready"
				? "https://github.com/acriver3/Laplace"
				: "https://github.com/acriver3/laplace-mcp-library",
	});
export const legacyBundleCatalog = snapshot.map((item) =>
	legacyCatalogEntry(item, browserConnectionsEnabled()),
);
export function bundleAvailable(artifact: BundleArtifact) {
	return acceptedBundle(artifact) || (artifact.published && artifact.candidate === true);
}

// Desktop-shipped demonstration adapter. There is no hosted YC runtime or remote bundle download.
legacyBundleCatalog.push(
	entrySchema.parse({
		id: "ycombinator-demo",
		...localConnectorMetadata("ycombinator-demo"),
		demoOnly: true,
		description:
			"Demo Only: read YC applications and save draft answers through your approved browser tab.",
		version: ycBrowserVersion,
		upstreamVersion: ycBrowserVersion,
		repository: "https://github.com/acriver3/Laplace",
		sourceSubdirectory: "apps/desktop",
		upstreamCommit: "f7bbfe431f329651c1f572013b9c2175f10d5dad",
		license: "Proprietary",
		recipe: "yc-demo",
		patches: [],
		reviewedAt: "2026-11-01",
		reviewNotes: [
			"Demonstration only. Uses the existing browser approval bridge. No hosted sign-in or credential export.",
		],
		reviewEvidence: ["apps/desktop/tests/yc-browser.test.ts"],
		prerequisites: [
			"Laplace Desktop",
			"Signed-in YC browser tab",
			"Laplace Browser Connection extension 0.3.0 or newer",
		],
		authentication: [
			"Sign in to YC normally in Chrome or Edge. Use Authenticate, open the Laplace extension on that YC tab, and approve reading applications and saving drafts. Keep the tab open. No cookies are copied.",
		],
		capabilities: [
			"Read application answers",
			"Preview and save draft changes",
			"Never submit applications",
		],
		artifacts: [],
	}),
);

// Historical entries remain resolvable for existing installations when defaults change.
export const tetheredBundleCatalog = [outlookArtifact, slackArtifact].map((artifact) => {
	const entry = legacyBundleCatalog.find((entry) => entry.id === artifact.catalogId)!;
	return entrySchema.parse({
		...entry,
		...localConnectorMetadata(entry.id, true),
		version: artifact.version,
		browserMode: "tethered",
		artifacts: [],
		repository: "https://github.com/acriver3/laplace-mcp-library",
		...(artifact.provider === "slack-tethered"
			? {
					capabilities: [
						"Read channels, messages, users, groups, saved items and attachments",
						"Send messages and change reactions, channel membership, read state, groups and saved items with existing permission controls",
					],
				}
			: {}),
		description:
			artifact.provider === "outlook"
				? "Use the selected account in your existing Chrome tab for mail, calendar, contacts, directory and attachments."
				: "Use your existing Chrome session for Slack conversations, messaging, channels, users, groups, saved items and attachments.",
		prerequisites: [
			"Signed-in account in existing Chrome",
			"Laplace Browser Connection extension 0.7.0 or newer",
		],
		authentication: [
			"Use Authenticate and approve the account, profile and full connector access. Keep the existing tab open.",
		],
	});
});
export const allBundleCatalog = [
	...new Map(
		[
			...snapshot.map((item) => legacyCatalogEntry(item, false)),
			...legacyBundleCatalog,
			...tetheredBundleCatalog,
		].map((entry) => [`${entry.id}@${entry.version}`, entry]),
	).values(),
];
export const bundleCatalog = legacyBundleCatalog.map((entry) =>
	browserEnabled()
		? (tetheredBundleCatalog.find((candidate) => candidate.id === entry.id) ?? entry)
		: entry,
);
export const tetheredEntry = (entry: BundleCatalogEntry) =>
	tetheredBundleCatalog.some(
		(candidate) => candidate.id === entry.id && candidate.version === entry.version,
	);
