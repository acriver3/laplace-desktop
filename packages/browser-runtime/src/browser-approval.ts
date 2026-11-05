import { z } from "zod";

import { slackWorkspace } from "./slack-browser";

export const browserIdentity = z
	.object({ workspace: z.string().url().max(2048), userId: z.string().min(1).max(200) })
	.passthrough();
export const browserCandidate = z
	.object({
		id: z.string().uuid(),
		profileId: z.string().uuid(),
		profileLabel: z.string().min(1).max(80),
		identity: browserIdentity,
		revision: z.string().uuid(),
	})
	.strict();
export type BrowserCandidate = z.infer<typeof browserCandidate>;
export const browserProviders = {
	"slack-tethered": {
		label: "Slack",
		scopes: [
			"Read channels, conversations, users, groups, saved items and attachments",
			"Send messages, change reactions, channel membership, read state, user groups and saved items when requested",
		],
		revision: "slack-full-v1",
		verify: "laplace_slack_verify",
	},
	outlook: {
		label: "Outlook",
		scopes: [
			"Read mail, calendars, contacts, directory, and attachments",
			"Send and change mail, calendar events, contacts, and mailbox settings when requested",
		],
		revision: "outlook-full-v1",
		verify: "outlook_list_folders",
	},
	slack: {
		label: "Slack",
		scopes: ["List channels", "Read conversation history and replies", "Search messages"],
		revision: "slack-reads-v1",
		verify: "channels_list",
	},
	ycombinator: {
		label: "Y Combinator · Demo Only",
		scopes: [
			"Read applications and answers",
			"Preview edits and save draft answers",
			"Never submit an application",
		],
		revision: "yc-drafts-v1",
		verify: "list_applications",
	},
} as const;
export type BrowserProviderId = keyof typeof browserProviders;
export function browserSignInUrl(provider: BrowserProviderId, workspace: string) {
	if (provider === "outlook") return "https://outlook.cloud.microsoft/mail/";
	if (provider === "ycombinator") return "https://apply.ycombinator.com/";
	return slackWorkspace(workspace);
}
export type BrowserApprovalView = {
	requestId: string;
	provider: string;
	workspace: string;
	signInUrl?: string;
	scopes: readonly string[];
	state:
		| "discovering"
		| "approval_required"
		| "sign_in_required"
		| "permission_required"
		| "verifying"
		| "connected"
		| "cancelled"
		| "expired"
		| "disconnected";
	profiles?: Array<{ profileId: string; profileLabel: string }>;
	candidates: BrowserCandidate[];
	selectedId?: string;
	message: string;
};
export const BROWSER_APPROVAL_URI = "ui://laplace/browser-approval.html";

export const identityKey = (value: Record<string, unknown>) =>
	JSON.stringify(
		Object.keys(value)
			.sort()
			.map((key) => [key, value[key]]),
	);
