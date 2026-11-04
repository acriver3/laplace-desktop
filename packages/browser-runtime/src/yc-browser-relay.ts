import { z } from "zod";

import { BrowserConnectionRelay } from "./browser-connection-relay";
import { ycWorkspace } from "./yc-browser";

const applicationId = z.string().uuid();
export const ycActions = {
	list_applications: { method: "applications.list", schema: z.object({}).strict() },
	read_application: { method: "application.read", schema: z.object({ applicationId }).strict() },
	save_draft: {
		method: "application.saveDraft",
		write: true,
		schema: z
			.object({
				applicationId,
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				changes: z
					.record(z.string(), z.string().max(20000))
					.refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 30),
				confirm: z.boolean().default(false),
			})
			.strict(),
	},
};
export class YcBrowserRelay extends BrowserConnectionRelay {
	constructor() {
		super({
			id: "ycombinator",
			label: "Y Combinator",
			workspace: ycWorkspace,
			identitySchema: z
				.object({ workspace: z.literal(ycWorkspace), userId: z.string().min(1).max(100) })
				.strict(),
			reads: ycActions,
		});
	}
}
