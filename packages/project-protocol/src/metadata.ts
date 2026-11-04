import { z } from "zod";

import { appToolCatalogSchema, appToolSchema } from "./app-connections";

export const appToolDisplayCatalogSchema = z.object({
	tools: appToolSchema
		.pick({ name: true, description: true, readOnly: true })
		.strip()
		.array()
		.max(100),
});

const thumbnail = z
	.object({ revision: z.string().min(1).max(128), captured_at: z.iso.datetime() })
	.strict();
export const projectMetadataSchema = z
	.object({
		appId: z.string().uuid(),
		organizationId: z.string().min(1).max(200),
		revision: z.string().min(1).max(128),
		sequence: z.number().int().positive(),
		tools: appToolCatalogSchema.shape.tools
			.nullable()
			.refine((tools) => tools === null || appToolCatalogSchema.safeParse({ tools }).success),
		thumbnail: z.object({ preview: thumbnail.nullable(), live: thumbnail.nullable() }).strict(),
		observedAt: z.iso.datetime(),
	})
	.strict();
export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;

/** Leave room for the envelope in the bounded Connect callback. Invalid catalogs
 * remain unavailable without turning a successful publication into a failure. */
export function publishedToolMetadata(tools: unknown): ProjectMetadata["tools"] {
	const parsed = appToolCatalogSchema.safeParse({ tools });
	if (
		!parsed.success ||
		new TextEncoder().encode(JSON.stringify(parsed.data.tools)).byteLength > 480_000
	)
		return null;
	return parsed.data.tools;
}
