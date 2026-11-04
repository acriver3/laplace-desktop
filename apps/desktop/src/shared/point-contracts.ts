import { z } from "zod";

export const pointDestination = z.enum([
	"codex-desktop",
	"claude-desktop",
	"chatgpt-desktop",
	"claude-browser",
	"chatgpt-browser",
	"claude-cli",
	"codex-cli",
]);
export type PointDestination = z.infer<typeof pointDestination>;
export const pointDestinationLabels: Record<PointDestination, string> = {
	"codex-desktop": "Codex desktop · current chat",
	"claude-desktop": "Claude desktop",
	"chatgpt-desktop": "ChatGPT desktop",
	"claude-browser": "Claude in browser",
	"chatgpt-browser": "ChatGPT in browser",
	"claude-cli": "Claude Code CLI",
	"codex-cli": "Codex CLI (OpenAI)",
};
export const pointSettings = z
	.object({
		enabled: z.boolean(),
		destination: pointDestination.default("codex-desktop"),
		shortcut: z
			.string()
			.trim()
			.min(3)
			.max(80)
			.refine(
				(value) => /^(?:(?:Control|Ctrl|Alt|Shift|Command|Cmd|Super)\+)+[A-Za-z0-9]$/.test(value),
				"Use modifiers and one letter or number, for example Control+L.",
			),
	})
	.strict();
export type PointSettings = z.infer<typeof pointSettings>;
export type PointSettingsInput = z.input<typeof pointSettings>;
export const defaultPointSettings: PointSettings = {
	enabled: false,
	shortcut: "Control+L",
	destination: "codex-desktop",
};
export const pointRect = z
	.object({
		x: z.number().finite().nonnegative(),
		y: z.number().finite().nonnegative(),
		width: z.number().finite().positive(),
		height: z.number().finite().positive(),
	})
	.strict();
export type PointRect = z.infer<typeof pointRect>;
export interface PointTarget {
	window: string;
	pid: number;
	version: string;
	chatLink: string;
}
export type PointResult =
	| "editor-ready"
	| "draft-ready"
	| "attachment-ready"
	| "needs-attention"
	| "ready-to-paste";
export interface PointCapture {
	destination?: PointDestination;
	id: string;
	createdAt: number;
	width: number;
	height: number;
	target?: PointTarget;
	/** Set before an attachment write: an uncertain outcome must not be replayed. */
	attachmentAttempted?: boolean;
	annotationAttempted?: boolean;
	handoffComplete?: boolean;
}
export interface PointState {
	settings: PointSettings;
	available: boolean;
	registered: boolean;
	phase: "idle" | "capturing" | "opening" | PointResult;
	message?: string;
	capture?: PointCapture;
	permissions: { screen: string; accessibility: boolean };
}
export const pointRequests = [
	z.object({ method: z.literal("shell.point.status") }).strict(),
	z.object({ method: z.literal("shell.point.configure"), input: pointSettings }).strict(),
	z.object({ method: z.literal("shell.point.capture") }).strict(),
	z.object({ method: z.literal("shell.point.retry") }).strict(),
	z.object({ method: z.literal("shell.point.copy") }).strict(),
	z.object({ method: z.literal("shell.point.clear") }).strict(),
	z.object({ method: z.literal("shell.point.permissions") }).strict(),
] as const;

/** Do not route arbitrary protocol URLs, new chats, or remote web links. */
export function pointChatLink(value: string): string | undefined {
	const trimmed = value.trim();
	return /^codex:\/\/threads\/[a-zA-Z0-9_-]{8,128}$/.test(trimmed) ? trimmed : undefined;
}

/** Renderer coordinates are display-local DIPs; use actual captured raster dimensions. */
export function pixelCrop(
	rect: PointRect,
	viewport: { width: number; height: number },
	pixels: { width: number; height: number },
): PointRect {
	pointRect.parse(rect);
	if (
		![viewport.width, viewport.height, pixels.width, pixels.height].every(
			(n) => Number.isFinite(n) && n > 0,
		)
	)
		throw new Error("Display dimensions are unavailable.");
	if (rect.x + rect.width > viewport.width + 0.01 || rect.y + rect.height > viewport.height + 0.01)
		throw new Error("Select a region within one display.");
	const x = Math.floor((rect.x * pixels.width) / viewport.width);
	const y = Math.floor((rect.y * pixels.height) / viewport.height);
	const right = Math.min(
		pixels.width,
		Math.ceil(((rect.x + rect.width) * pixels.width) / viewport.width),
	);
	const bottom = Math.min(
		pixels.height,
		Math.ceil(((rect.y + rect.height) * pixels.height) / viewport.height),
	);
	if (right - x < 2 || bottom - y < 2) throw new Error("Select a larger region.");
	return { x, y, width: right - x, height: bottom - y };
}
