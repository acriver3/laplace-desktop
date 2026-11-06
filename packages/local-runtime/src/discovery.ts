import type { DeviceLink } from "./device-link";
import type { HostedConnections } from "./hosted-oauth";
import type { DesktopManager } from "./manager";
import { desktopVersion } from "./shared/version";

export type Discovery = {
	status(clientId: string): Promise<unknown>;
	setup(clientId: string, target: "local" | "browser"): Promise<unknown>;
};

/** Local implementations of `laplace_status` and `laplace_setup` for registered AI clients. */
export function localDiscovery(
	manager: DesktopManager,
	hosted: Pick<HostedConnections, "connect" | "status">,
	link: Pick<DeviceLink, "start">,
	origin: string,
	openUrl: (url: string) => void,
): Discovery {
	const summary = (clientId: string) => {
		const snapshot = manager.status();
		const servers = snapshot.servers.map((server) => ({
			id: server.id,
			name: server.name,
			status: server.status,
			enabled: server.enabled,
			linkMode: server.linkMode,
			sharedRemotely: !!server.access?.remoteEnabled,
			tools: server.tools.filter((tool) => tool.enabled).length,
		}));
		const linked = snapshot.mode === "linked" && !!snapshot.installationId;
		return {
			runtime: { version: desktopVersion, mode: snapshot.mode },
			account: linked
				? { linked: true, origin: snapshot.origin }
				: { linked: false, note: "Local connectors work without a Laplace account." },
			connectors: servers,
			remoteSharing: servers.some((server) => server.sharedRemotely)
				? "Some connectors are shared; hosted AI clients still need to be selected in Laplace → Devices."
				: "Off",
			hostedConnection: hosted.status(clientId).hosted,
			nextSteps: [
				...(servers.length
					? []
					: ["Add a connector with local_connectors_* tools or in Laplace → On this device."]),
				...servers
					.filter((server) => server.status === "needs_attention")
					.map((server) => `Review "${server.name}" in Laplace → On this device.`),
				...(linked
					? []
					: [
							"To use this computer from other devices or browser AI clients, call laplace_setup with target=browser.",
						]),
			],
		};
	};
	return {
		async status(clientId) {
			return summary(clientId);
		},
		async setup(clientId, target) {
			if (target === "local")
				return {
					target,
					installed: true,
					runtime: { version: desktopVersion },
					status: summary(clientId),
					reconnectRequired: false,
				};
			const snapshot = manager.status();
			if (snapshot.mode !== "linked" || !snapshot.installationId) {
				const started = (await link.start(origin, `Laplace Runtime ${desktopVersion}`)) as {
					verificationUrl?: string;
					approvalCode?: string;
					expiresAt?: number;
				};
				if (started.verificationUrl) openUrl(started.verificationUrl);
				return {
					target,
					step: "link-computer",
					...started,
					instructions:
						"Ask the user to approve this computer at the verification URL, then call laplace_status.",
					reconnectRequired: false,
				};
			}
			const connection = await hosted.connect(clientId, true);
			return {
				target,
				step: "connect-hosted-tools",
				hostedConnection: connection,
				instructions:
					"The user approves this AI client's hosted Laplace access in their browser. Hosted tools then appear in this connection.",
				reconnectRequired:
					"Only if hosted tools do not appear after approval; older MCP clients may need a restart.",
			};
		},
	};
}
