import type { ConnectorUpdateStatus } from "@repo/local-mcp-core/connector-updates";
import { Button } from "@repo/ui/components/button";
import { CircleArrowUp, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Modal } from "./Dialogs";

type Run = (method: string, input?: unknown) => Promise<boolean>;

/** Whether a connection card should show the update icon. Pinned versions stay quiet. */
export function showsUpdateIcon(row?: ConnectorUpdateStatus) {
	if (!row) return false;
	if (row.phase === "downloading" || row.phase === "installing") return true;
	return !!row.availableVersion && !row.pinned;
}

/** The icon itself. Clicking it never installs directly; it opens the confirmation. */
export function ConnectorUpdateIcon({
	row,
	onOpen,
}: {
	row: ConnectorUpdateStatus;
	onOpen: () => void;
}) {
	const name = row.name ?? row.id;
	const working = row.phase === "downloading" || row.phase === "installing";
	const label = working
		? `${name}: ${row.phase === "downloading" ? "downloading" : "installing"} update`
		: `Update available for ${name}: ${row.version} to ${row.availableVersion}`;
	return (
		<Button
			variant="outline"
			size="icon"
			className={
				row.blocked
					? "connector-update-icon text-warning"
					: "connector-update-icon text-primary"
			}
			aria-label={label}
			title={label}
			aria-haspopup="dialog"
			onClick={onOpen}
		>
			{working ? (
				<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
			) : (
				<CircleArrowUp className="size-4" aria-hidden="true" />
			)}
		</Button>
	);
}

/** Confirmation for one connector update: install, keep this version, or cancel a download. */
export function ConnectorUpdateDialog({
	row,
	busy,
	error,
	run,
	close,
}: {
	row: ConnectorUpdateStatus;
	busy: boolean;
	error?: string;
	run: Run;
	close: () => void;
}) {
	const name = row.name ?? row.id;
	const working = row.phase === "downloading" || row.phase === "installing";
	return (
		<Modal title={`Update ${name}`} close={close}>
			<div className="dialog-body stack">
				<p>
					Installed {row.version}
					{row.availableVersion ? ` · Available ${row.availableVersion}` : ""}
				</p>
				<p className="text-sm text-muted-foreground">
					The update is verified before it replaces the current version, and the current
					version is restored if the connector fails to start. Your sign-in and settings
					are kept.
				</p>
				{row.message && (
					<p role="status" className={row.blocked ? "text-warning" : undefined}>
						{row.message}
					</p>
				)}
				{error && (
					<p role="alert" className="danger-text">
						{error}
					</p>
				)}
				{row.phase === "downloading" && <p role="status">Downloading update…</p>}
				{row.phase === "installing" && (
					<p role="status">Installing and checking connector…</p>
				)}
				{!row.availableVersion && !working && !error && (
					<p role="status">{name} is up to date.</p>
				)}
			</div>
			<div className="dialog-actions">
				{row.phase === "downloading" ? (
					<Button
						variant="outline"
						onClick={() => void run("updates.cancelConnector", { id: row.id })}
					>
						Cancel download
					</Button>
				) : (
					<>
						<Button
							variant="outline"
							disabled={busy || working || !row.availableVersion}
							onClick={() =>
								void run("updates.pin", { id: row.id, pinned: true }).then(
									(ok) => ok && close(),
								)
							}
						>
							Keep this version
						</Button>
						<Button variant="outline" onClick={close}>
							Not now
						</Button>
						<Button
							disabled={busy || working || row.blocked || !row.availableVersion}
							onClick={() => void run("updates.applyConnector", { id: row.id })}
						>
							{busy ? "Updating…" : `Install ${row.availableVersion ?? "update"}`}
						</Button>
					</>
				)}
			</div>
		</Modal>
	);
}

/** Update icon for a connection card, with its confirmation dialog. */
export function ConnectorUpdateControl({
	row,
	busy,
	error,
	run,
}: {
	row?: ConnectorUpdateStatus;
	busy: boolean;
	error?: string;
	run: Run;
}) {
	const [open, setOpen] = useState(false);
	if (!row || (!showsUpdateIcon(row) && !open)) return null;
	return (
		<>
			<ConnectorUpdateIcon row={row} onOpen={() => setOpen(true)} />
			{open && (
				<ConnectorUpdateDialog
					row={row}
					busy={busy}
					error={error}
					run={run}
					close={() => setOpen(false)}
				/>
			)}
		</>
	);
}
