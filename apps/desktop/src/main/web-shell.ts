import { z } from "zod";

// Presentation only: no paths, account data, or privileged local operations.
export const webShellRequest = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("status") }).strict(),
	z.object({ kind: z.literal("credentials-navigation") }).strict(),
	z.object({ kind: z.literal("update-status") }).strict(),
	z.object({ kind: z.literal("show-updates") }).strict(),
	z.object({ kind: z.literal("web") }).strict(),
	z
		.object({
			kind: z.literal("layout"),
			rect: z
				.object({
					x: z.number().finite().min(0).max(100_000),
					y: z.number().finite().min(0).max(100_000),
					width: z.number().finite().positive().max(100_000),
					height: z.number().finite().positive().max(100_000),
					blocked: z.boolean(),
				})
				.strict()
				.nullable(),
		})
		.strict(),
]);
