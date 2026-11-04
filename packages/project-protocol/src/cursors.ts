import { z } from "zod";

export const WORKSPACE_CURSOR_TTL = 8_000;
export const workspaceCursorSchema = z
	.object({
		environment: z.enum(["preview", "live"]),
		revision: z.string().min(1).max(200),
		path: z
			.string()
			.min(1)
			.max(1000)
			.refine((path) => path.startsWith("/") && !/[?#\p{Cc}]/u.test(path)),
		x: z.number().finite().min(0).max(1_000_000),
		y: z.number().finite().min(0).max(1_000_000),
		width: z.number().finite().positive().max(50_000),
		height: z.number().finite().positive().max(50_000),
		scrollX: z.number().finite().min(0).max(1_000_000),
		scrollY: z.number().finite().min(0).max(1_000_000),
	})
	.strict();
export type WorkspaceCursor = z.infer<typeof workspaceCursorSchema>;
export const workspaceCursorUpdateSchema = z
	.object({ type: z.literal("workspace:cursor"), cursor: workspaceCursorSchema.nullable() })
	.strict();
export const workspaceObserverSchema = z
	.object({ userId: z.string().min(1).max(200), name: z.string().trim().min(1).max(80) })
	.strict();
export type WorkspaceObserver = z.infer<typeof workspaceObserverSchema>;
export const workspaceCursorEventSchema = z
	.object({
		type: z.literal("workspace:cursor"),
		id: z.string().uuid(),
		userId: z.string().min(1).max(200),
		name: z.string().min(1).max(80),
		color: z.string().regex(/^#[a-f0-9]{6}$/),
		cursor: workspaceCursorSchema.nullable(),
		at: z.number().finite(),
	})
	.strict();
export type WorkspaceCursorEvent = z.infer<typeof workspaceCursorEventSchema>;
