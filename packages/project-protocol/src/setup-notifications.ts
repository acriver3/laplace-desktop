import { z } from "zod";
export const setupNotificationOwner = z
	.object({
		accountId: z.string().min(1).max(200),
		installationId: z.string().uuid(),
		origin: z.string().url(),
	})
	.strict();
export type SetupNotificationOwner = z.infer<typeof setupNotificationOwner>;
export const setupNotificationResult = z
	.object({
		jobId: z.string().uuid(),
		connectorName: z.string().trim().min(1).max(120),
		operation: z.enum(["install", "authenticate", "verify"]),
		status: z.enum(["completed", "failed"]),
		finishedAt: z.string().datetime(),
	})
	.strict();
export const setupNotificationBatch = z
	.object({
		accountId: z.string().min(1).max(200),
		installationId: z.string().uuid(),
		results: z.array(setupNotificationResult).min(1).max(50),
	})
	.strict();
export function setupNotificationText(
	result: z.infer<typeof setupNotificationResult>,
	device: string,
) {
	const action =
		result.status === "failed"
			? "setup failed"
			: result.operation === "authenticate"
				? "connected"
				: result.operation === "install"
					? "installed"
					: "verified";
	return {
		title: `${result.connectorName} ${action}`,
		message: `${device} · ${result.operation === "authenticate" ? "Authentication" : result.operation === "install" ? "Installation" : "Verification"}. ${result.status === "failed" ? "Open Connections to review setup. Details are available in Desktop diagnostics." : "Open Connections to review your connection."}`,
	};
}
