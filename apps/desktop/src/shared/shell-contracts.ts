import { brokerTarget } from "@repo/project-protocol/credential-broker";
import { z } from "zod";

import { assistantTarget } from "./assistant-setup";
import { catalogSetupTarget } from "./catalog-setup";
import { pointRequests } from "./point-contracts";
import type { DesktopUpdateState } from "./update-contracts";

export const profiles = {
	hosted: { name: "Hosted Laplace", origin: "https://connect.withlaplace.com" },
	local: { name: "Local development", origin: "http://127.0.0.1:3004" },
} as const;
export type Profile = keyof typeof profiles;
/** Signed in, Desktop shows Connect itself; "local" shows the native On this device pages. */
export type ShellMode = "web" | "local";
// Keep "device" as an alias for older agents and Desktop links.
export const localSection = z.enum([
	"servers",
	"clients",
	"info",
	"tools",
	"settings",
	"updates",
	"credentials",
	"device",
]);
export type LocalSection = z.infer<typeof localSection>;
export const resolveLocalSection = (section: LocalSection) =>
	section === "device" ? "settings" : section;

export const shellRequest = z.discriminatedUnion("method", [
	...pointRequests,
	z
		.object({
			method: z.literal("shell.updatePreferences"),
			input: z
				.object({ desktop: z.boolean().optional(), connectors: z.boolean().optional() })
				.strict(),
		})
		.strict(),
	z.object({ method: z.literal("shell.updatePostpone") }).strict(),
	z
		.object({
			method: z.literal("shell.brokerSetup"),
			input: z
				.object({
					clientId: z.string().uuid(),
					sessionId: z.string().uuid(),
					targets: z.array(brokerTarget).min(1).max(50),
					target: assistantTarget,
					action: z.enum(["instructions", "open"]),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			method: z.literal("shell.catalogSetup"),
			input: z
				.object({
					catalogId: z.string().min(1).max(120),
					connectionId: z
						.string()
						.regex(/^[A-Za-z0-9_-]{1,80}$/)
						.optional(),
					target: catalogSetupTarget,
					action: z.enum(["instructions", "open"]),
				})
				.strict(),
		})
		.strict(),
	z.object({ method: z.literal("shell.updateCheck") }).strict(),
	z.object({ method: z.literal("shell.updateDownload") }).strict(),
	z.object({ method: z.literal("shell.updateCancel") }).strict(),
	z.object({ method: z.literal("shell.updateInstall") }).strict(),
	z.object({ method: z.literal("shell.updateChanges") }).strict(),
	z
		.object({
			method: z.literal("shell.assistantSetup"),
			input: z
				.object({
					clientId: z.string().uuid(),
					target: assistantTarget,
					action: z.enum(["instructions", "open"]),
				})
				.strict(),
		})
		.strict(),
	z.object({ method: z.literal("shell.status") }).strict(),
	z.object({ method: z.literal("shell.dismissUnlock") }).strict(),
	z
		.object({
			method: z.literal("shell.local"),
			input: z.object({ section: localSection }).strict(),
		})
		.strict(),
	z.object({ method: z.literal("shell.web") }).strict(),
	z
		.object({
			method: z.literal("shell.profile"),
			input: z.object({ profile: z.enum(["hosted", "local"]) }).strict(),
		})
		.strict(),
	z.object({ method: z.literal("shell.reload") }).strict(),
	z.object({ method: z.literal("shell.signIn") }).strict(),
	z.object({ method: z.literal("shell.cancelSignIn") }).strict(),
	z.object({ method: z.literal("shell.signOut") }).strict(),
	z.object({ method: z.literal("shell.accounts") }).strict(),
	z
		.object({
			method: z.literal("shell.link"),
			input: z
				.object({
					accountId: z.string().min(1).max(200),
					name: z.string().min(1).max(120).default("Laplace Desktop"),
				})
				.strict(),
		})
		.strict(),
	z.object({ method: z.literal("shell.pickImport") }).strict(),
	z.object({ method: z.literal("shell.pickBundles") }).strict(),
	z.object({ method: z.literal("shell.pickDirectory") }).strict(),
	z.object({ method: z.literal("shell.quit") }).strict(),
]);

export interface ShellState {
	unlockSessionId?: string;
	/** Native content is displayed inside the persistent Connect shell. */
	localEmbedded?: boolean;
	localContentVersion?: number;
	updates?: DesktopUpdateState;
	profile: Profile;
	origin: string;
	mode: ShellMode;
	section: LocalSection;
	loading: boolean;
	webError?: string;
	helperError?: string;
	signIn: "idle" | "waiting" | "complete";
	browserSignIn: boolean | null;
	/** Full-web Desktop support advertised by Connect; 0 when the server predates it. */
	webShellVersion: number | null;
	accountError?: string;
	account?: { id: string; name: string };
	accounts: { id: string; name: string }[];
}

export interface DesktopBridge {
	pathForFile?(file: File): string;
	invoke<T = unknown>(method: string, input?: unknown): Promise<T>;
	onEvent(listener: (event: { event: string; data?: unknown }) => void): () => void;
}

declare global {
	interface Window {
		laplaceDesktop: DesktopBridge;
	}
}
