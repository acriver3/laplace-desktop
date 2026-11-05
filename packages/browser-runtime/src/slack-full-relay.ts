import { z } from "zod";

import { BrowserConnectionRelay } from "./browser-connection-relay";
import { browserTransferLimit } from "./browser-transfer";
import { slackWorkspace } from "./slack-browser";

export const slackFullReads = [
	"auth.test",
	"users.list",
	"users.info",
	"conversations.list",
	"conversations.info",
	"conversations.members",
	"conversations.history",
	"conversations.replies",
	"conversations.genericInfo",
	"users.conversations",
	"search.all",
	"search.messages",
	"files.info",
	"client.userBoot",
	"client.counts",
	"client.dms",
	"im.list",
	"users.prefs.get",
	"search.modules.channels",
	"usergroups.list",
	"usergroups.users.list",
	"saved.list",
];
export const slackFullWrites = [
	"chat.postMessage",
	"reactions.add",
	"reactions.remove",
	"conversations.mark",
	"conversations.leave",
	"conversations.join",
	"conversations.open",
	"conversations.view",
	"usergroups.create",
	"usergroups.update",
	"usergroups.users.update",
	"saved.update",
	"saved.clearCompleted",
];
export const slackEdgeReads = ["users/info", "users/list", "users/search", "channels/membership"];
const params = z.object({ params: z.record(z.string().min(1).max(100), z.unknown()) }).strict();
export const slackFullActions = Object.fromEntries([
	...slackFullReads.map((name) => [
		"api." + name,
		{ method: "api." + name, schema: params, maxResultBytes: browserTransferLimit },
	]),
	...slackFullWrites.map((name) => [
		"api." + name,
		{
			method: "api." + name,
			schema: params,
			write: true,
			maxInputBytes: browserTransferLimit,
			maxResultBytes: browserTransferLimit,
		},
	]),
	...slackEdgeReads.map((name) => [
		"edge." + name,
		{ method: "edge." + name, schema: params, maxResultBytes: browserTransferLimit },
	]),
	[
		"files.download",
		{
			method: "files.download",
			schema: z.object({ url: z.string().url().max(8000) }).strict(),
			maxResultBytes: browserTransferLimit,
		},
	],
]);
export class SlackFullBrowserRelay extends BrowserConnectionRelay {
	constructor(workspace: string) {
		super({
			id: "slack-tethered",
			label: "Slack",
			workspace: slackWorkspace(workspace),
			identitySchema: z
				.object({
					workspace: z.string().transform(slackWorkspace),
					teamId: z.string().regex(/^[TE][A-Z0-9]{5,40}$/),
					userId: z.string().regex(/^[UW][A-Z0-9]{5,40}$/),
				})
				.strict(),
			reads: slackFullActions,
		});
	}
}
