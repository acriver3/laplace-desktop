import { z } from "zod";

import { BrowserConnectionRelay } from "./browser-connection-relay";
import { browserTransferLimit } from "./browser-transfer";

export const outlookWorkspace = "https://outlook.cloud.microsoft";
const request = z
	.object({
		path: z.string().min(1).max(4096),
		params: z.record(z.string(), z.string().max(8000)).optional(),
		body: z.unknown().optional(),
		large: z.boolean().optional(),
	})
	.strict();
// The extension independently validates each method's fixed endpoint allowlist.
export const outlookActions = Object.fromEntries(
	[
		"owa.get",
		"owa.cloudSettings",
		"owa.post",
		"owa.patch",
		"owa.delete",
		"graph.getPath",
		"graph.binary",
		"account.status",
	].map((method) => [
		method,
		{
			method,
			schema: method === "account.status" ? z.object({}).strict() : request,
			write: ["owa.post", "owa.patch", "owa.delete"].includes(method),
			maxInputBytes: browserTransferLimit,
			maxResultBytes: browserTransferLimit,
		},
	]),
);
export class OutlookBrowserRelay extends BrowserConnectionRelay {
	constructor() {
		super({
			id: "outlook",
			label: "Outlook",
			workspace: outlookWorkspace,
			identitySchema: z
				.object({
					workspace: z.literal(outlookWorkspace),
					userId: z.string().min(1).max(200),
					tenantId: z.string().min(1).max(200),
					accountId: z.string().min(1).max(200),
					accountLabel: z.string().min(1).max(200).optional(),
				})
				.strict(),
			reads: outlookActions,
		});
	}
}
