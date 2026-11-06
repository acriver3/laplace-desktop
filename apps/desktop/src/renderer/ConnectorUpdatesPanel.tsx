import { Button } from "@repo/ui/components/button";

import { useConnectorUpdates } from "./useConnectorUpdates";
export function ConnectorUpdatesPanel({ id }: { id?: string }) {
	const { rows, error, busy, run } = useConnectorUpdates();
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
									void run("updates.pin", {
										id: row.id,
										pinned: event.target.checked,
									})
								}
							/>{" "}
							Keep this version
						</label>
						{row.message && <p role="status">{row.message}</p>}
						{row.phase === "downloading" && (
							<Button
								onClick={() => void run("updates.cancelConnector", { id: row.id })}
							>
								Cancel download
							</Button>
						)}
						{row.phase === "installing" && (
							<p role="status">Installing and checking connector…</p>
						)}
						{row.availableVersion && (
							<Button
								disabled={busy || row.blocked}
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
