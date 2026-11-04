import { z } from "zod";

import { BrowserConnectionRelay } from "./browser-connection-relay";
import { slackWorkspace } from "./slack-browser";
export { redactBrowserResult } from "./browser-connection-relay";
const channel = z.string().regex(/^[CGD][A-Z0-9]{5,40}$/);
const cursor = z.string().max(2048).optional();
const limit = z.number().int().min(1).max(100).default(50);
export const slackReads = {
	channels_list: { method: "conversations.list", schema: z.object({ cursor, limit }).strict() },
	conversations_history: {
		method: "conversations.history",
		schema: z.object({ channel, cursor, limit }).strict(),
	},
	conversations_replies: {
		method: "conversations.replies",
		schema: z
			.object({ channel, ts: z.string().regex(/^\d{10,20}\.\d{1,10}$/), cursor, limit })
			.strict(),
	},
	conversations_search_messages: {
		method: "search.messages",
		schema: z
			.object({
				query: z.string().min(1).max(2000),
				count: z.number().int().min(1).max(100).default(50),
				page: z.number().int().min(1).max(100).default(1),
			})
			.strict(),
	},
};
const identitySchema = z
	.object({
		workspace: z.string().transform(slackWorkspace),
		teamId: z.string().regex(/^[TE][A-Z0-9]{5,40}$/),
		userId: z.string().regex(/^[UW][A-Z0-9]{5,40}$/),
	})
	.strict();

export class SlackBrowserRelay extends BrowserConnectionRelay {
	constructor(workspace: string) {
		super({
			id: "slack",
			label: "Slack",
			workspace: slackWorkspace(workspace),
			identitySchema,
			reads: slackReads,
		});
	}
}
