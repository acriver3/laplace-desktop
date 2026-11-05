import { Button } from "@repo/ui/components/button";
import { SettingsItem } from "@repo/ui/components/connector/settings-item";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import type { DesktopUpdateState } from "../shared/update-contracts";
import { ConnectorUpdatesPanel } from "./ConnectorUpdatesPanel";
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
	const action = (method: string) => void perform(() => invoke(method));
	return (
		<SettingsItem
			title="Updates"
			description="Choose when Laplace and its managed connectors update."
		>
			<div className="stack">
				{(
					[
						["desktop", "Automatically update Laplace Desktop"],
						["connectors", "Automatically update managed connectors"],
					] as const
				).map(([key, label]) => (
					<label key={key} className="gap-2 flex items-center">
						<input
							type="checkbox"
							checked={update?.policy?.[key] ?? false}
							onChange={(event) => {
								const checked = event.target.checked;
								void perform(() => invoke("shell.updatePreferences", { [key]: checked }));
							}}
						/>
						{label}
					</label>
				))}
				<p className="text-sm text-muted-foreground">
					Updates apply after 15 minutes of computer inactivity, when local tools and approvals are
					idle. The connector setting also applies to Laplace Local CLI.
				</p>
				{update?.automaticEnabled === false && (
					<p className="text-sm">
						Automatic installation is not activated for this release. Your preferences are saved.
					</p>
				)}
				{update?.restartAt && (
					<div role="status">
						<p>
							Laplace will restart in {Math.max(0, Math.ceil((update.restartAt - now) / 1000))}{" "}
							seconds if your computer stays idle.
						</p>
						<Button variant="outline" onClick={() => action("shell.updatePostpone")}>
							Postpone 24 hours
						</Button>
					</div>
				)}

				{update && (
					<p className="text-sm">
						Installed version: {update.installedVersion}
						{update.availableVersion ? ` · Available: ${update.availableVersion}` : ""}
					</p>
				)}
				{update?.availableVersion && (
					<p className="text-sm">
						A new version of Laplace Desktop is available. Download and prepare it now, then restart
						to install when you’re ready.{" "}
						<button
							type="button"
							className="underline"
							onClick={() => action("shell.updateChanges")}
						>
							View changes in {update.availableVersion}
						</button>
					</p>
				)}
				{busy && (
					<p role="status" className="gap-2 text-sm flex items-center">
						<LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />
						{labels[phase]}
					</p>
				)}
				{update?.message && (
					<p role={phase === "error" ? "alert" : "status"} className="text-sm">
						{update.message}
					</p>
				)}
				{phase === "unmanaged" && !update?.message && (
					<p className="text-sm">
						Run source:install from your Laplace clone once to enable in-app updates.
					</p>
				)}
				<div className="gap-2 flex flex-wrap">
					{phase !== "unmanaged" && phase !== "ready" && (
						<Button variant="outline" disabled={busy} onClick={() => action("shell.updateCheck")}>
							Check for updates
						</Button>
					)}
					{(phase === "available" || (phase === "error" && update?.availableVersion)) && (
						<Button onClick={() => action("shell.updateDownload")}>Download update</Button>
					)}
					{["checking", "downloading", "building", "verifying"].includes(phase) && (
						<Button variant="outline" onClick={() => action("shell.updateCancel")}>
							Cancel
						</Button>
					)}
					{phase === "ready" && (
						<Button onClick={() => action("shell.updateInstall")}>Restart to install</Button>
					)}
				</div>
				<ConnectorUpdatesPanel />
				{phase === "ready" && (
					<p className="text-sm text-muted-foreground">
						Restarting stops active local tools. On Windows, close AI clients that are using Laplace
						before restarting.
					</p>
				)}
			</div>
		</SettingsItem>
	);
}
