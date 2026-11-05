import type { ConnectorUpdateStatus } from "@repo/local-mcp-core/connector-updates";
import { Button } from "@repo/ui/components/button";
import { useEffect, useState } from "react";

import { invoke } from "./types";
export function ConnectorUpdatesPanel({ id }: { id?: string }) {
	const [rows, setRows] = useState<ConnectorUpdateStatus[]>([]);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const run = async (method: string, input?: unknown) => {
		setBusy(true);
		setError(undefined);
		try {
			const value = await invoke<ConnectorUpdateStatus[]>(method, input);
			setRows(Array.isArray(value) ? value : []);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Connector update failed");
		} finally {
			setBusy(false);
		}
	};
	useEffect(() => {
		void run("updates.connectors");
		const timer = setInterval(() => {
			void invoke<ConnectorUpdateStatus[]>("updates.connectors")
				.then((value) => setRows(Array.isArray(value) ? value : []))
				.catch(() => {});
		}, 15000);
		return () => clearInterval(timer);
	}, []);
	return (
		<div className="stack">
			{!id && (
				<Button
					variant="outline"
					disabled={busy}
					onClick={() => void run("updates.checkConnectors")}
				>
					Check connector updates
				</Button>
			)}
			{error && <p role="alert">{error}</p>}
			{rows
				.filter((row) => !id || row.id === id)
				.map((row) => (
					<div key={row.id} className="stack">
						<p>
							{row.name ?? row.id} · Installed {row.version}
							{row.availableVersion ? ` · Available ${row.availableVersion}` : ""}
						</p>
						<label>
							<input
								type="checkbox"
								disabled={busy}
								checked={row.pinned}
								onChange={(event) =>
									void run("updates.pin", { id: row.id, pinned: event.target.checked })
								}
							/>{" "}
							Keep this version
						</label>
						{row.message && <p role="status">{row.message}</p>}
						{row.phase === "downloading" && (
							<Button onClick={() => void run("updates.cancelConnector", { id: row.id })}>
								Cancel download
							</Button>
						)}
						{row.phase === "installing" && <p role="status">Installing and checking connector…</p>}
						{row.availableVersion && (
							<Button
								disabled={busy}
								onClick={() => void run("updates.applyConnector", { id: row.id })}
							>
								Update connector
							</Button>
						)}
					</div>
				))}
		</div>
	);
}
