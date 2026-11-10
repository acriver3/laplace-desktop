import { Button } from "@repo/ui/components/button";
import { SettingsItem } from "@repo/ui/components/connector/settings-item";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import type { DesktopUpdateState } from "../shared/update-contracts";
import { ConnectorUpdatesPanel } from "./ConnectorUpdatesPanel";
import { SettingLabel, SettingToggle } from "./SettingControls";
import { invoke, type Perform } from "./types";

export function UpdatesPanel({
	update,
	perform,
}: {
	update?: DesktopUpdateState;
	perform: Perform;
}) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!update?.restartAt) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [update?.restartAt]);
	const phase = update?.phase ?? "unmanaged";
	const busy = ["checking", "downloading", "building", "verifying", "installing"].includes(phase);
	const labels: Record<string, string> = {
		checking: "Checking for updates…",
		downloading: "Downloading update…",
		building: "Building update…",
		verifying: "Verifying update…",
		installing: "Preparing to restart…",
	};
	const statusLabels: Record<string, string> = {
		unmanaged: "Development build",
		available: "Update available",
		ready: "Ready to install",
		error: "Needs attention",
		idle: update?.checkedAt ? "Up to date" : "Ready to check",
		...labels,
	};
	const status = statusLabels[phase];
	const action = (method: string) => void perform(() => invoke(method));
	return (
		<section className="desktop-settings-panel" aria-label="Update settings">
			<SettingsItem title="Updates">
				<div className="desktop-settings-content">
					<section className="desktop-settings-subsection" aria-label="Automatic updates">
						<div className="desktop-setting-toggle-group">
							{(
								[
									[
										"desktop",
										"Enable Automatic Updates",
										"Update Laplace Desktop after 15 minutes of computer inactivity, when local tools and approvals are idle.",
									],
									[
										"connectors",
										"Enable Automatic Connector Updates",
										"Update managed connectors after 15 minutes of computer inactivity, when local tools and approvals are idle. This preference also applies to Laplace Local CLI.",
									],
								] as const
							).map(([key, label, hint]) => (
								<SettingToggle
									key={key}
									id={`automatic-updates-${key}`}
									label={label}
									hint={hint}
									checked={update?.policy?.[key] ?? false}
									onChange={(event) => {
										const checked = event.target.checked;
										void perform(() => invoke("shell.updatePreferences", { [key]: checked }));
									}}
								/>
							))}
						</div>
						{update?.automaticEnabled === false && (
							<p className="desktop-setting-note">
								Automatic installation is not activated for this release. Your preferences are
								saved.
							</p>
						)}
					</section>
					{update?.restartAt && (
						<div role="status" className="desktop-setting-note">
							<p>
								Laplace will restart in {Math.max(0, Math.ceil((update.restartAt - now) / 1000))}{" "}
								seconds if your computer stays idle.
							</p>
							<Button variant="outline" onClick={() => action("shell.updatePostpone")}>
								Postpone 24 hours
							</Button>
						</div>
					)}
					<section className="desktop-settings-subsection" aria-label="Desktop app updates">
						<div className="desktop-settings-section-heading">
							<h4>
								<SettingLabel
									label="Laplace Desktop"
									hint={
										phase === "unmanaged"
											? "This development build does not install app updates. Run source:install from your Laplace clone to enable in-app updates."
											: "Download an update now, then restart to install when ready. Restarting stops active local tools; close AI clients using Laplace on Windows before restarting."
									}
								/>
							</h4>
							<span className="desktop-setting-badge" data-state={phase}>
								{status}
							</span>
						</div>
						{update && (
							<p className="desktop-setting-version">
								Installed version: {update.installedVersion}
								{update.availableVersion ? ` · Available: ${update.availableVersion}` : ""}
							</p>
						)}
						{busy && (
							<p role="status" className="desktop-setting-progress">
								<LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />
								{labels[phase]}
							</p>
						)}
						{update?.message && (
							<p
								role={phase === "error" ? "alert" : "status"}
								className="desktop-setting-note"
								data-kind={phase === "error" ? "error" : undefined}
							>
								{update.message}
							</p>
						)}
						<div className="desktop-settings-actions">
							{phase !== "unmanaged" && phase !== "ready" && (
								<Button
									variant="outline"
									disabled={busy}
									onClick={() => action("shell.updateCheck")}
								>
									Check for updates
								</Button>
							)}
							{(phase === "available" || (phase === "error" && update?.availableVersion)) && (
								<Button variant="primary" onClick={() => action("shell.updateDownload")}>
									Download update
								</Button>
							)}
							{["checking", "downloading", "building", "verifying"].includes(phase) && (
								<Button variant="outline" onClick={() => action("shell.updateCancel")}>
									Cancel
								</Button>
							)}
							{phase === "ready" && (
								<Button variant="primary" onClick={() => action("shell.updateInstall")}>
									Restart to install
								</Button>
							)}
							{update?.availableVersion && (
								<Button variant="ghost" onClick={() => action("shell.updateChanges")}>
									View changes in {update.availableVersion}
								</Button>
							)}
						</div>
					</section>
					<section className="desktop-settings-subsection" aria-label="Managed connector updates">
						<h4>Managed connectors</h4>
						<ConnectorUpdatesPanel />
					</section>
				</div>
			</SettingsItem>
		</section>
	);
}
