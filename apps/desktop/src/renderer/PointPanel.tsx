import { Button } from "@repo/ui/components/button";
import { SettingsItem } from "@repo/ui/components/connector/settings-item";
import { useEffect, useState } from "react";

import {
	pointDestinationLabels,
	type PointDestination,
	type PointState,
} from "../shared/point-contracts";
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
		void invoke<PointState>("shell.point.status")
			.then(update)
			.catch(() => setError("Point could not load."));
		return window.laplaceDesktop.onEvent((event) => {
			if (event.event === "point") update(event.data as PointState);
		});
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
	return (
		<SettingsItem
			title="Laplace Point"
			description="Snip any app and bring it to your preferred agent. You choose when to send."
		>
			<div className="stack">
				<p className="small muted">
					Codex current-chat delivery attaches to the draft. Other desktop and browser destinations
					open with the snip copied for you to paste. CLI destinations copy a local screenshot path
					for your running agent session.
				</p>
				<label className="row">
					<input
						type="checkbox"
						aria-label="Enable Laplace Point"
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
					Enable Laplace Point
				</label>
				{state && !state.available && (
					<p className="small muted">
						Point requires a Windows or macOS Desktop build with its native adapter.
					</p>
				)}
				<div className="row wrap">
					<label htmlFor="point-destination">Default agent</label>
					<select
						id="point-destination"
						value={state?.settings.destination ?? "codex-desktop"}
						disabled={
							!state || busy || ["capturing", "opening", "editor-ready"].includes(state.phase)
						}
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
				<div className="row wrap">
					<label htmlFor="point-shortcut">Capture shortcut</label>
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
						onClick={() => void perform("shell.point.configure", { ...state!.settings, shortcut })}
					>
						Save shortcut
					</Button>
				</div>
				<p className="small muted">
					Your capture shortcut takes over this key combination in other apps while Point is
					enabled.
				</p>
				{state?.settings.enabled && (
					<p className="small">
						{state.registered
							? "Shortcut ready"
							: "Shortcut unavailable — capture from the tray or choose another combination."}
					</p>
				)}
				{state &&
					(state.permissions.screen !== "granted" ||
						(state.settings.destination === "codex-desktop" &&
							!state.permissions.accessibility)) && (
						<div className="stack">
							<p className="small">
								Allow Screen Recording for Laplace in macOS System Settings. Codex current-chat
								delivery also needs Accessibility.
							</p>
							<Button
								variant="outline"
								onClick={() => void perform("shell.point.permissions")}
								disabled={busy}
							>
								Set up permissions
							</Button>
						</div>
					)}
				<div className="row wrap">
					<Button
						disabled={
							!state?.available ||
							!state.settings.enabled ||
							busy ||
							["capturing", "opening", "editor-ready"].includes(state.phase)
						}
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
					<p className="small muted">
						Saved snip destination:{" "}
						{pointDestinationLabels[state.capture.destination ?? "codex-desktop"]}
					</p>
				)}
				{state?.message && (
					<p role="status" className="small">
						{state.message}
					</p>
				)}
				{error && (
					<p role="alert" className="small">
						{error}
					</p>
				)}
				<div className="row wrap">
					<span className="small muted">Selected snips stay on this device for seven days.</span>
					<Button
						variant="outline"
						disabled={
							!state || busy || ["capturing", "opening", "editor-ready"].includes(state.phase)
						}
						onClick={() => void perform("shell.point.clear")}
					>
						Clear Point captures
					</Button>
				</div>
			</div>
		</SettingsItem>
	);
}
