import { z } from "zod";

export const SUGGESTION_STALE_MS = 90_000;
export const suggestionBodySchema = z.string().trim().min(1).max(4000);
export const suggestionReasonSchema = z.string().trim().max(500);
export const suggestionTaskContextSchema = z
	.object({
		suggestion_id: z.string().uuid(),
		claim_id: z.string().uuid(),
		agent_session_id: z.string().min(1).max(100),
	})
	.strict();
export type SuggestionTaskContext = z.infer<typeof suggestionTaskContextSchema>;

export function suggestionIsStalled(
	row: { executionStatus: string | null; heartbeatAt: Date | string | null },
	now = Date.now(),
) {
	return (
		row.executionStatus === "working" &&
		(!row.heartbeatAt || now - new Date(row.heartbeatAt).getTime() >= SUGGESTION_STALE_MS)
	);
}

/** Coordinates refer to the app's viewport, never to a signed preview URL. */
export const suggestionAnnotationSchema = z
	.object({
		environment: z.enum(["preview", "live"]),
		revision: z.string().min(1).max(100),
		path: z
			.string()
			.max(1000)
			.regex(/^\/(?!\/)[^?#\r\n]*$/),
		x: z.number().finite().min(0).max(1),
		y: z.number().finite().min(0).max(1),
		width: z.number().int().min(1).max(50000),
		height: z.number().int().min(1).max(50000),
		scrollX: z.number().finite().min(0).max(1000000),
		scrollY: z.number().finite().min(0).max(1000000),
	})
	.strict();
export type SuggestionAnnotation = z.infer<typeof suggestionAnnotationSchema>;
const replyEventSchema = z.object({
	event: z.enum(["reply_added", "reply_edited"]),
	id: z.string().uuid(),
	userId: z.string(),
	authorName: z.string(),
	body: suggestionBodySchema,
	at: z.string(),
});
export type SuggestionReply = {
	id: string;
	userId: string;
	authorName: string;
	body: string;
	createdAt: string;
	editedAt: string | null;
	version: number;
};
export function suggestionDiscussion(history: unknown) {
	const replies = new Map<string, SuggestionReply>();
	let annotation: SuggestionAnnotation | null = null;
	let edited = false;
	for (const value of Array.isArray(history) ? history : []) {
		if (value?.event === "annotated") {
			const parsed = suggestionAnnotationSchema.safeParse(value.annotation);
			if (parsed.success) annotation = parsed.data;
		}
		if (value?.event === "request_edited") edited = true;
		const parsed = replyEventSchema.safeParse(value);
		if (!parsed.success) continue;
		const event = parsed.data;
		const previous = replies.get(event.id);
		if (event.event === "reply_added" && !previous) {
			replies.set(event.id, {
				id: event.id,
				userId: event.userId,
				authorName: event.authorName,
				body: event.body,
				createdAt: event.at,
				editedAt: null,
				version: 1,
			});
		} else if (event.event === "reply_edited" && previous?.userId === event.userId) {
			replies.set(event.id, {
				...previous,
				body: event.body,
				editedAt: event.at,
				version: previous.version + 1,
			});
		}
	}
	return { replies: [...replies.values()], annotation, edited };
}
