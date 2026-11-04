import { useEffect, useRef, useState } from "react";

import {
	assistantTarget,
	assistantNames,
	type AssistantTarget,
	type AssistantSetup,
} from "../shared/assistant-setup";
import type { ClientSnapshot, DesktopSnapshot } from "../shared/helper-contracts";
import { Modal } from "./Dialogs";
import { invoke, type CatalogEntry } from "./types";
/** Copy fallback is supported by every locally connected assistant; no silent dispatch. */
export function BrokerStart({
	entries,
	label = "Connect with assistant",
	batch = false,
}: {
	entries: CatalogEntry[];
	label?: string;
	batch?: boolean;
}) {
	const [clients, setClients] = useState<ClientSnapshot[]>([]);
	const [clientId, setClientId] = useState("");
	const [target, setTarget] = useState<AssistantTarget>("codex");
	const [targetIds] = useState<Record<string, string>>({});
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const request = useRef({ fingerprint: "", id: crypto.randomUUID() });
	const [settings, setSettings] = useState<{
			enabled: boolean;
			accountId?: string;
			installationId?: string;
		}>(),
		[open, setOpen] = useState(false),
		[selected, setSelected] = useState<Record<string, string>>({}),
		[message, setMessage] = useState("");
	useEffect(() => {
		void invoke<DesktopSnapshot>("status")
			.then((s) => {
				const enabled = s.clients.filter((c) => c.enabled);
				setClients(enabled);
				setClientId(enabled[0]?.id ?? "");
			})
			.catch(() => {});
		void invoke<{ enabled: boolean; accountId?: string; installationId?: string }>("broker.enabled")
			.then(setSettings)
			.catch(() => {});
	}, []);
	if (!settings?.enabled) return null;
	const eligible = entries.filter((e) => e.available && !e.importOnly);
	async function prepare() {
		const chosen = eligible.filter((e) => (batch ? selected[e.id] : true));
		if (!chosen.length || chosen.length > 50) return;
		const targets = chosen.map((e) => ({
			id: targetIds[e.id] ?? (targetIds[e.id] = crypto.randomUUID()),
			service: e.id,
			label: e.name,
			location: "local",
			catalogId: e.id,
			connectionId: e.installed ? e.serverId : undefined,
			authType: selected[e.id] || "browser",
		}));
		const fingerprint = JSON.stringify({ clientId, targets });
		if (request.current.fingerprint !== fingerprint)
			request.current = { fingerprint, id: crypto.randomUUID() };
		setBusy(true);
		try {
			const result = await invoke<AssistantSetup>("shell.brokerSetup", {
				clientId,
				target,
				sessionId: request.current.id,
				targets,
				action: "open",
			});
			setDraft(result.prompt);
			setMessage(
				result.opened
					? "Review and send the prepared draft in your assistant. Your connection request is saved."
					: "Open your assistant and copy the request below to continue.",
			);
		} catch {
			setMessage(
				"Could not prepare this request. Check that the selected assistant has credential and connector-management access in AI clients.",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="broker-start">
			<button type="button" onClick={() => setOpen((v) => !v)}>
				{label}
			</button>
			{open && (
				<Modal title="Prepare credential matching" close={() => setOpen(false)}>
					<section className="dialog-body stack" aria-label="Prepare credential matching">
						<label>
							Connected assistant
							<select value={clientId} onChange={(e) => setClientId(e.target.value)}>
								{clients.map((c) => (
									<option value={c.id} key={c.id}>
										{c.name}
									</option>
								))}
							</select>
						</label>
						{!clients.length && (
							<button onClick={() => void invoke("shell.local", { section: "clients" })}>
								Connect an assistant
							</button>
						)}
						<label>
							Open with
							<select
								value={target}
								onChange={(e) => setTarget(assistantTarget.parse(e.target.value))}
							>
								{assistantTarget.options.map((t) => (
									<option key={t} value={t}>
										{assistantNames[t]}
									</option>
								))}
							</select>
						</label>
						<p>
							Choose a credential source for each connection. Your assistant will propose matches
							for your review.
						</p>
						{eligible.map((e) => (
							<label key={e.id} style={{ display: "block" }}>
								{batch && (
									<input
										type="checkbox"
										checked={!!selected[e.id]}
										onChange={(event) =>
											setSelected((v) => ({ ...v, [e.id]: event.target.checked ? "browser" : "" }))
										}
									/>
								)}
								{e.name}
								<select
									aria-label={"Credential source for " + e.name}
									disabled={batch && !selected[e.id]}
									value={selected[e.id] || "browser"}
									onChange={(event) => setSelected((v) => ({ ...v, [e.id]: event.target.value }))}
								>
									<option value="browser">Bitwarden browser login</option>
									<option value="custom_credential">Doppler configuration fields</option>
								</select>
							</label>
						))}
						<button type="button" disabled={busy || !clientId} onClick={() => void prepare()}>
							{busy ? "Preparing…" : "Continue with assistant"}
						</button>
						{message && <p role="status">{message}</p>}
						{draft && (
							<>
								<textarea aria-label="Assistant request" readOnly value={draft} rows={4} />
								<button
									onClick={() =>
										void navigator.clipboard
											.writeText(draft)
											.then(() =>
												setMessage("Request copied. Paste and send it in your assistant."),
											)
									}
								>
									Copy request
								</button>
							</>
						)}
					</section>
				</Modal>
			)}
		</div>
	);
}
