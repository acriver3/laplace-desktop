import { z } from "zod";
export const githubInput = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("connect"),
		installationId: z.string().regex(/^\d+$/),
		repositoryId: z.string().regex(/^\d+$/),
		branch: z.string().min(1).max(200),
		root: z.string().max(240).default(""),
	}),
	z.object({ action: z.literal("preview") }),
	z.object({ action: z.literal("refresh") }),
	z.object({ action: z.literal("disconnect") }),
	z.object({
		action: z.literal("import"),
		revision: z.string(),
		remoteCommit: z.string(),
		requestId: z.string().uuid(),
	}),
	z.object({
		action: z.literal("reconcile"),
		revision: z.string(),
		remoteCommit: z.string(),
		requestId: z.string().uuid(),
		choices: z.record(z.string(), z.enum(["workspace", "github"])).default({}),
	}),
	z.object({
		action: z.literal("push"),
		revision: z.string(),
		remoteCommit: z.string(),
		requestId: z.string().uuid(),
		message: z.string().trim().min(1).max(500),
	}),
]);
export type GithubInput = z.input<typeof githubInput>;
