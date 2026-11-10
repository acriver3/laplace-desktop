import { Button } from "@repo/ui/components/button";

import { useConnectorUpdates } from "./useConnectorUpdates";
export function ConnectorUpdatesPanel({ id }: { id?: string }) {
	const { rows, error, busy, run } = useConnectorUpdates();
	const visible = rows.filter((row) => !id || row.id === id);
	return (
		<div className="desktop-connector-updates">
			{!id && (
				<div className="desktop-settings-actions">
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => void run("updates.checkConnectors")}
					>
						Check connector updates
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="desktop-setting-note" data-kind="error">
					{error}
				</p>
			)}
			{!visible.length && !busy && !error && (
				<p className="desktop-setting-help">
					{id ? "No update details available." : "No managed connectors installed."}
				</p>
			)}
			{visible.map((row) => (
				<div key={row.id} className="desktop-connector-update">
					<div className="desktop-settings-section-heading">
						<div className="desktop-setting-copy">
							<strong>{row.name ?? row.id}</strong>
							<p className="desktop-setting-version">
								Installed {row.version}
								{row.availableVersion ? ` · Available ${row.availableVersion}` : ""}
							</p>
						</div>
						<label className="desktop-setting-checkbox">
							<input
								type="checkbox"
								disabled={busy}
								checked={row.pinned}
								onChange={(event) =>
									void run("updates.pin", { id: row.id, pinned: event.target.checked })
								}
							/>
							<span>Keep this version</span>
						</label>
					</div>
					{row.message && (
						<p role="status" className="desktop-setting-help">
							{row.message}
						</p>
					)}
					{row.phase === "installing" && (
						<p role="status" className="desktop-setting-help">
							Installing and checking connector…
						</p>
					)}
					<div className="desktop-settings-actions">
						{row.phase === "downloading" && (
							<Button
								variant="outline"
								onClick={() => void run("updates.cancelConnector", { id: row.id })}
							>
								Cancel download
							</Button>
						)}
						{row.availableVersion && (
							<Button
								variant="primary"
								disabled={busy || row.blocked}
								onClick={() => void run("updates.applyConnector", { id: row.id })}
							>
								Update connector
							</Button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}
