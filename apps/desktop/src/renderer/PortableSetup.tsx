import type { PortableOperation } from "@repo/project-protocol/portable-connectors";
import { useEffect, useState } from "react";

import { invoke, type CatalogEntry } from "./types";

export function PortableSetup() {
	const [operations, setOperations] = useState<PortableOperation[]>([]);
	const [error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const [editing, setEditing] = useState<string>(),
		[fields, setFields] = useState<CatalogEntry["fields"]>([]),
		[values, setValues] = useState<Record<string, string>>({});
	const refresh = async () =>
		setOperations(await invoke<PortableOperation[]>("portable.status", {}));
	useEffect(() => {
		void refresh().catch(() => {});
		const timer = setInterval(() => void refresh().catch(() => {}), 1500);
		return () => clearInterval(timer);
	}, []);
	const run = async (work: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		try {
			await work();
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Operation failed");
		} finally {
			setBusy(false);
		}
	};
	const manage = (command: Record<string, unknown>) =>
		invoke("portable.manage", { idempotencyKey: crypto.randomUUID(), command });
	const pending = operations.filter((operation) => operation.status !== "completed");
	if (!pending.length && !error && !editing) return null;
	return (
		<div className="stack" aria-label="Connector setup progress">
			{error && <p role="alert">{error}</p>}
			{pending.map((op) => (
				<div className="stack" key={op.id}>
					<strong>{op.name ?? "Connector setup"}</strong>
					<p role="status">
						{op.status.replaceAll("_", " ")} · {op.message}
					</p>
					<div className="row wrap">
						{op.status === "running" && (
							<button
								disabled={busy}
								onClick={() => void run(() => manage({ action: "cancel", id: op.id }))}
							>
								Cancel
							</button>
						)}
						{["failed", "cancelled", "interrupted"].includes(op.status) && (
							<button
								disabled={busy}
								onClick={() => void run(() => manage({ action: "retry", id: op.id }))}
							>
								Retry
							</button>
						)}
						<button
							disabled={busy || op.status === "running"}
							onClick={() =>
								void run(async () => {
									const next = await invoke<CatalogEntry["fields"]>("portable.fields", {
										id: op.connectorId,
									});
									setFields(next);
									setValues(Object.fromEntries(next.map((f) => [f.key, f.default ?? ""])));
									setEditing(op.connectorId);
								})
							}
						>
							Configure
						</button>
						{["authenticate", "verify", "repair"].map((action) => (
							<button
								key={action}
								disabled={busy || op.status === "running" || op.status === "needs_configuration"}
								onClick={() => void run(() => manage({ action, id: op.connectorId }))}
							>
								{action === "authenticate"
									? "Sign in on this device"
									: action === "verify"
										? "Verify"
										: "Repair"}
							</button>
						))}
					</div>
				</div>
			))}
			{editing && (
				<form
					className="stack"
					onSubmit={(e) => {
						e.preventDefault();
						void run(async () => {
							await manage({
								action: "configure",
								id: editing,
								configuration: values,
							});
							setEditing(undefined);
							setValues({});
						});
					}}
				>
					{fields.map((f) => (
						<label key={f.key}>
							{f.label}
							<input
								type={f.type === "password" ? "password" : "text"}
								required={f.required}
								value={values[f.key] ?? ""}
								onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
							/>
						</label>
					))}
					<button disabled={busy}>Save settings</button>
					<button
						type="button"
						onClick={() => {
							setEditing(undefined);
							setValues({});
						}}
					>
						Cancel
					</button>
				</form>
			)}
		</div>
	);
}
