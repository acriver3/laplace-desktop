import { useEffect, useState } from "react";

import { invoke } from "./types";

type Peer = {
	id: string;
	name: string;
	online: boolean;
	connections: { id: string; name: string; remoteEnabled: boolean; portableReady: boolean }[];
};

export function PortablePeers() {
	const [devices, setDevices] = useState<Peer[]>([]),
		[busy, setBusy] = useState(false),
		[message, setMessage] = useState("");
	useEffect(() => {
		let active = true;
		const refresh = () =>
			void invoke<Peer[]>("portable.devices", {})
				.then((value) => {
					if (active) setDevices(value);
				})
				.catch(() => {
					if (active) setDevices([]);
				});
		refresh();
		const timer = setInterval(refresh, 10000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, []);
	if (!devices.length) return null;
	return (
		<section className="stack" aria-label="Connectors on your other devices">
			<strong>Your other devices</strong>
			<p>
				Use an online desktop through your connected AI client, or make an independent copy on this
				device.
			</p>
			{devices.map((device) => (
				<div className="stack" key={device.id}>
					<strong>
						{device.name} {device.online ? "(Online)" : "(Offline)"}
					</strong>
					{device.connections.map((connection) => (
						<div className="row wrap" key={connection.id}>
							<span>
								{connection.name} -{" "}
								{connection.remoteEnabled
									? device.online
										? `Runs on ${device.name}`
										: "Host unavailable"
									: "Keep local"}
							</span>
							<details>
								<summary>Actions</summary>
								<button
									disabled={busy || !connection.portableReady}
									onClick={() => {
										setBusy(true);
										setMessage("");
										void invoke("portable.copy", {
											sourceId: connection.id,
											idempotencyKey: crypto.randomUUID(),
										})
											.then(() =>
												setMessage(
													"Copy started. Complete settings and fresh sign-in in the setup progress above.",
												),
											)
											.catch((e: unknown) =>
												setMessage(e instanceof Error ? e.message : "Copy failed"),
											)
											.finally(() => setBusy(false));
									}}
								>
									Make local copy
								</button>
								{!connection.portableReady && (
									<p>Reconnect the source desktop to finish syncing its bundle.</p>
								)}
							</details>
						</div>
					))}
				</div>
			))}
			{message && <p role="status">{message}</p>}
		</section>
	);
}
