import { Button } from "@repo/ui/components/button";
import { SettingsItem } from "@repo/ui/components/connector/settings-item";
import { useEffect, useState } from "react";

import {
	pointDestinationLabels,
	type PointDestination,
	type PointState,
} from "../shared/point-contracts";
import { SettingHint, SettingLabel, SettingToggle } from "./SettingControls";
import { invoke } from "./types";

export function PointPanel() {
	const [state, setState] = useState<PointState>();
	const [shortcut, setShortcut] = useState("Control+L");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		const update = (next: PointState | undefined) => {
			if (next?.settings && typeof next.available === "boolean") setState(next);
		};
		const refresh = () => {
			void invoke<PointState>("shell.point.status")
				.then(update)
				.catch(() => setError("Point could not load."));
		};
		refresh();
		window.addEventListener("focus", refresh);
		const unsubscribe = window.laplaceDesktop.onEvent((event) => {
			if (event.event === "point") update(event.data as PointState);
		});
		return () => {
			window.removeEventListener("focus", refresh);
			unsubscribe();
		};
	}, []);
	const savedShortcut = state?.settings.shortcut;
	useEffect(() => {
		if (savedShortcut) setShortcut(savedShortcut);
	}, [savedShortcut]);
	const perform = async (method: string, input?: unknown) => {
		setBusy(true);
		setError(undefined);
		try {
			await invoke(method, input);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Point could not complete the action.");
		} finally {
			setBusy(false);
		}
	};
	const active = !!state && ["capturing", "opening", "editor-ready"].includes(state.phase);
	return (
		<section className="desktop-settings-panel" aria-label="Laplace Point settings">
			<SettingsItem
				title={
					<SettingLabel
						label="Laplace Point"
						hint="Capture part of your screen and bring it to your agent. You choose when to send. Snips stay on this device for seven days."
					/>
				}
			>
				<div className="desktop-settings-content">
					<SettingToggle
						id="point-enabled"
						label="Enable Laplace Point"
						hint="Capture a region of your screen with the keyboard shortcut or Capture with Point."
						checked={state?.settings.enabled ?? false}
						disabled={!state?.available || busy}
						onChange={(event) =>
							void perform("shell.point.configure", {
								...state!.settings,
								enabled: event.target.checked,
								shortcut,
							})
						}
					/>
					{state && !state.available && (
						<p className="desktop-setting-note">
							Point requires a Windows or macOS Desktop build with its native adapter.
						</p>
					)}
					<div className="desktop-settings-fields">
						<div className="desktop-setting-field">
							<SettingLabel
								htmlFor="point-destination"
								label="Default agent"
								hint="Codex desktop attaches to the current draft. Other desktop and browser agents receive a copied snip; CLI agents receive a local path to paste."
							/>
							<select
								id="point-destination"
								value={state?.settings.destination ?? "codex-desktop"}
								disabled={!state || busy || active}
								onChange={(event) =>
									void perform("shell.point.configure", {
										...state!.settings,
										destination: event.target.value as PointDestination,
									})
								}
							>
								{Object.entries(pointDestinationLabels).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
						</div>
						<div className="desktop-setting-field">
							<SettingLabel
								htmlFor="point-shortcut"
								label="Capture shortcut"
								hint="This key combination is reserved in other apps while Point is enabled."
							/>
							<div className="desktop-setting-input-action">
								<input
									id="point-shortcut"
									value={shortcut}
									maxLength={80}
									onChange={(event) => setShortcut(event.target.value)}
									placeholder="Control+L"
									disabled={busy}
								/>
								<Button
									variant="outline"
									disabled={!state?.available || busy || shortcut === state.settings.shortcut}
									onClick={() =>
										void perform("shell.point.configure", { ...state!.settings, shortcut })
									}
								>
									Save shortcut
								</Button>
							</div>
						</div>
					</div>
					{state?.settings.enabled && !state.registered && (
						<p className="desktop-setting-help">
							Shortcut unavailable — capture from the tray or choose another combination.
						</p>
					)}
					{state &&
						(state.permissions.screen !== "granted" ||
							(state.settings.destination === "codex-desktop" &&
								!state.permissions.accessibility)) && (
							<div className="desktop-setting-note">
								{state.permissions.screen !== "granted" && (
									<p>Allow Screen Recording for Laplace in macOS System Settings.</p>
								)}
								{state.settings.destination === "codex-desktop" &&
									!state.permissions.accessibility && (
										<p>
											Allow Accessibility for Laplace in macOS System Settings so Point can attach
											snips to Codex.
										</p>
									)}
								<Button
									variant="outline"
									onClick={() => void perform("shell.point.permissions")}
									disabled={busy}
								>
									Set up permissions
								</Button>
							</div>
						)}
					<div className="desktop-settings-actions">
						<Button
							variant="primary"
							disabled={!state?.available || !state.settings.enabled || busy || active}
							onClick={() => void perform("shell.point.capture")}
						>
							Capture with Point
						</Button>
						{state?.capture && (
							<>
								<Button
									variant="outline"
									disabled={
										busy ||
										state.phase === "editor-ready" ||
										state.phase === "opening" ||
										!!state.capture.attachmentAttempted ||
										!!state.capture.annotationAttempted ||
										!!state.capture.handoffComplete
									}
									onClick={() => void perform("shell.point.retry")}
								>
									{state.capture.destination && state.capture.destination !== "codex-desktop"
										? "Copy and open again"
										: "Retry snip"}
								</Button>
								<Button
									variant="outline"
									disabled={busy}
									onClick={() => void perform("shell.point.copy")}
								>
									Copy snip
								</Button>
							</>
						)}
					</div>
					{state?.capture && (
						<p className="desktop-setting-help">
							Saved snip destination:{" "}
							{pointDestinationLabels[state.capture.destination ?? "codex-desktop"]}
						</p>
					)}
					{state?.message && (
						<p role="status" className="desktop-setting-note">
							{state.message}
						</p>
					)}
					{error && (
						<p role="alert" className="desktop-setting-note" data-kind="error">
							{error}
						</p>
					)}
					<div className="desktop-settings-footer">
						<div className="desktop-settings-actions">
							<Button
								variant="outline"
								disabled={!state || busy || active}
								onClick={() => void perform("shell.point.clear")}
							>
								Clear Point captures
							</Button>
							<SettingHint
								label="saved captures"
								hint="Selected snips stay on this device for seven days. Clear Point captures removes the saved snips now."
							/>
						</div>
					</div>
				</div>
			</SettingsItem>
		</section>
	);
}
