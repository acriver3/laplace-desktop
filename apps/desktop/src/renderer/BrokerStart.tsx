import { brokerHandoff } from "@repo/project-protocol/credential-broker";
import { useEffect, useState } from "react";

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
	const [settings, setSettings] = useState<{
			enabled: boolean;
			accountId?: string;
			installationId?: string;
		}>(),
		[open, setOpen] = useState(false),
		[selected, setSelected] = useState<Record<string, string>>({}),
		[message, setMessage] = useState("");
	useEffect(() => {
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
			id: crypto.randomUUID(),
			service: e.id,
			label: e.name,
			location: "local",
			catalogId: e.id,
			connectionId: e.installed ? e.serverId : undefined,
			authType: selected[e.id] || "browser",
		}));
		const prompt =
			brokerHandoff(crypto.randomUUID(), settings!.accountId ?? "local", targets).replace(
				"Use Laplace credential_broker",
				"Use Laplace local_credential_broker",
			) +
			(settings!.installationId ? "\nDesktop installation ID: " + settings!.installationId : "") +
			"\nUse the invoking local assistant and this Desktop. If a flow is unsupported, show its manual setup instructions.";
		try {
			await navigator.clipboard.writeText(prompt);
			setMessage(
				"Request copied. Paste it into your connected assistant. Unlock Bitwarden in Credentials; configure Doppler sources in Laplace Connections.",
			);
		} catch {
			setMessage(
				"Clipboard unavailable. Use the assistant's local_credential_broker tool or continue with manual setup.",
			);
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
						<button type="button" onClick={() => void prepare()}>
							Copy assistant request
						</button>
						{message && <p role="status">{message}</p>}
					</section>
				</Modal>
			)}
		</div>
	);
}
