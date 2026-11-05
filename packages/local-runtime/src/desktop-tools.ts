import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";

import { desktopVersion } from "./shared/version";
import type { HostedConnections } from "./hosted-oauth";
import type { DesktopManager } from "./manager";

const section = z.enum(["servers", "clients", "device", "updates", "credentials"]);
export type DesktopSection = z.infer<typeof section>;
const input = z.discriminatedUnion("action", [
	z.object({ action: z.literal("status") }).strict(),
	z.object({ action: z.literal("open"), section }).strict(),
	z
		.object({ action: z.literal("authorize"), desktopManagement: z.boolean().default(false) })
		.strict(),
	z.object({ action: z.literal("disconnect") }).strict(),
	z
		.object({
			action: z.enum(["start", "stop", "restart"]),
			id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
		})
		.strict(),
]);
export const desktopManagementTool: Tool = {
	name: "local_desktop_manage",
	description:
		"Inspect sanitized Desktop linking, this assistant's authorization, and connector health; open Desktop settings; start hosted authorization for this assistant; disconnect its hosted tools; or start/stop/restart a connector. Existing local tool permissions apply. Authorization opens user consent; it never grants permission itself. Use existing local_connectors tools for connector configuration. Vault unlock, permission changes, and credential approval remain in Desktop. Never send secrets. After authorize, poll status; do not repeat authorization while connecting.",
	inputSchema: { ...z.toJSONSchema(input, { io: "input" }), type: "object" } as Tool["inputSchema"],
	annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};
export async function manageDesktop(
	manager: DesktopManager,
	hosted: Pick<HostedConnections, "status" | "connect" | "disconnect">,
	clientId: string,
	value: unknown,
	open: (section: DesktopSection) => void,
) {
	manager.client(clientId);
	if (!manager.clientToolAllowed(clientId, desktopManagementTool.name))
		throw Error("Desktop management is disabled for this assistant.");
	const args = input.parse(value);
	if (args.action === "open") open(args.section);
	else if (args.action === "authorize") {
		if (hosted.status(clientId).hosted !== "connecting")
			await hosted.connect(clientId, true, args.desktopManagement);
	} else if (args.action === "disconnect") await hosted.disconnect(clientId);
	else if (args.action === "start" || args.action === "stop" || args.action === "restart") {
		if (!manager.clientToolAllowed(clientId, "local_connectors_manage"))
			throw Error("Connector management is disabled for this assistant.");
		if (args.action === "restart") await manager.restartServer(args.id);
		else await manager.setEnabled(args.id, args.action === "start");
	}
	const s = manager.status();
	return {
		version: desktopVersion,
		mode: s.mode,
		origin: s.origin,
		accountId: s.accountId,
		installationId: s.installationId,
		assistant: { id: clientId, ...hosted.status(clientId) },
		servers: s.servers.map(({ id, name, status, enabled }) => ({ id, name, status, enabled })),
		guidance:
			s.mode === "linked"
				? "Hosted authorization applies to this assistant only."
				: "Open Device and link this computer to the intended account. Account selection and approval are user-only.",
	};
}
