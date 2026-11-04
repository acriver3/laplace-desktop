import { useEffect, useState, useRef } from "react";

import type { BrokerSession } from "../../../credential-broker";
export type BrokerView = Omit<BrokerSession, "receipts" | "principalId">;
export function BrokerReviewCard({
	view,
	busy,
	error,
	act,
}: {
	view: BrokerView;
	busy: boolean;
	error: string;
	act: (action: "approve" | "review" | "cancel" | "desktop" | "retry", ids?: string[]) => void;
}) {
	const [selected, setSelected] = useState<string[]>([]);
	const selectionRevision = useRef("");
	useEffect(() => {
		const revision = `${view.id}:${view.revision}`;
		if (selectionRevision.current === revision) return;
		selectionRevision.current = revision;
		setSelected(view.items.filter((i) => i.state === "review_required").map((i) => i.target.id));
	}, [view.id, view.revision, view.items]);
	return (
		<section className="broker-review" aria-label="Credential review">
			<h2>Connect with your saved credentials</h2>
			<p>
				Review the destination and source for each connection. Passwords and API keys stay out of
				chat.
			</p>
			{view.items.map((item) => (
				<article key={item.target.id}>
					<label>
						<input
							type="checkbox"
							checked={selected.includes(item.target.id)}
							disabled={busy || !["review_required", "failed"].includes(item.state)}
							onChange={(e) =>
								setSelected((s) =>
									e.target.checked
										? [...s, item.target.id]
										: s.filter((id) => id !== item.target.id),
								)
							}
						/>
						<strong>{item.target.label}</strong> ({item.target.service}) · {item.target.location}
					</label>
					<p>
						{item.target.connectionId
							? "Reconnect " + item.target.connectionId
							: "Create or reuse the verified account"}{" "}
						· {item.target.authType}
					</p>
					<p>
						Access:{" "}
						{item.target.authType === "oauth2"
							? "open sign-in in your regular Chrome profile using the Laplace extension and fill the approved login; provider OAuth permissions are shown separately on its consent page"
							: item.target.authType === "browser"
								? "sign in to the selected browser account"
								: "configure and verify the listed credential fields"}
						. Approval applies only to these mappings.
					</p>
					<ul>
						{item.matches.map((m) => (
							<li key={m.field}>
								{m.field}:{" "}
								{m.source.kind === "bitwarden"
									? "Bitwarden: " +
										(m.label ?? m.source.credentialId) +
										" · " +
										(m.origins ?? []).join(", ")
									: "Doppler " + m.source.project + "/" + m.source.config + "/" + m.source.name}
							</li>
						))}
					</ul>
					<p role="status">
						{item.state.replaceAll("_", " ")} — {item.message}
					</p>
				</article>
			))}
			{error && <p role="alert">{error}</p>}
			<div className="actions">
				<button
					disabled={
						busy ||
						!view.items.some((i) => selected.includes(i.target.id) && i.state === "review_required")
					}
					onClick={() =>
						act(
							"approve",
							view.items
								.filter((i) => selected.includes(i.target.id) && i.state === "review_required")
								.map((i) => i.target.id),
						)
					}
				>
					Approve selected
				</button>
				{view.items.some((i) => i.state === "failed") && (
					<button
						disabled={
							busy ||
							!view.items.some((i) => selected.includes(i.target.id) && i.state === "failed")
						}
						onClick={() =>
							act(
								"retry",
								view.items
									.filter((i) => selected.includes(i.target.id) && i.state === "failed")
									.map((i) => i.target.id),
							)
						}
					>
						Review selected failures again
					</button>
				)}
				<button disabled={busy} onClick={() => act("review")}>
					Refresh
				</button>
				<button disabled={busy} onClick={() => act("desktop")}>
					Open Desktop
				</button>
				<button disabled={busy} onClick={() => act("cancel")}>
					Cancel remaining
				</button>
			</div>
			<p>
				To change a match, ask your assistant to propose another saved login or secret before
				approving. MFA and OAuth consent remain yours to complete.
			</p>
		</section>
	);
}
