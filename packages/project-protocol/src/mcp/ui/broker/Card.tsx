import { useEffect, useState, useRef } from "react";

import type {
	BrokerSession,
	CredentialCandidate,
	CredentialMatch,
} from "../../../credential-broker";
export type BrokerView = Omit<BrokerSession, "receipts" | "principalId">;
export function BrokerReviewCard({
	view,
	busy,
	error,
	act,
	candidates,
}: {
	view: BrokerView;
	busy: boolean;
	error: string;
	act: (action: string, ids?: string[], extra?: Record<string, unknown>) => void;
	candidates?: { items: CredentialCandidate[]; nextCursor?: number };
}) {
	const [selected, setSelected] = useState<string[]>([]);
	const selectionRevision = useRef("");
	const [editing, setEditing] = useState<string>();
	const [draft, setDraft] = useState<CredentialMatch[]>([]);
	const [query, setQuery] = useState("");
	const blocked = view.readiness && !["ready", "choose_credential"].includes(view.readiness.code);
	const canConnect = (item: BrokerView["items"][number]) =>
		view.workflowVersion === 2 &&
		item.state === "matching" &&
		item.target.authType === "oauth2" &&
		item.target.location === "cloud" &&
		!item.attempted &&
		!item.matches.length;

	useEffect(() => {
		const revision = `${view.id}:${view.revision}`;
		if (selectionRevision.current === revision) return;
		selectionRevision.current = revision;
		setSelected(
			view.items
				.filter((i) => i.state === "review_required" || canConnect(i))
				.map((i) => i.target.id),
		);
	}, [view.id, view.revision, view.items]);
	return (
		<section className="broker-review" aria-label="Credential review">
			<h2>
				{view.items.some((i) => i.target.connectionId)
					? "Reconnect your accounts"
					: "Connect your accounts"}
			</h2>
			<p>
				Review the destination and source for each connection. Passwords and API keys stay out of
				chat.
			</p>
			<p>
				Destination:{" "}
				{view.accountId ? `Laplace account ${view.accountId}` : "This device (account not linked)"}
			</p>
			{view.readiness && blocked && (
				<div className="broker-next" role="status">
					<p>{view.readiness.message}</p>
					<button disabled={busy} onClick={() => act(view.readiness!.action ?? "desktop")}>
						{view.readiness.action === "unlock"
							? "Unlock Bitwarden"
							: view.readiness.code === "enable_chrome"
								? "Set up Chrome"
								: "Continue setup in Desktop"}
					</button>
				</div>
			)}
			{busy && (
				<p role="status" aria-live="polite">
					Working… Your request is being processed.
				</p>
			)}
			{view.items.map((item) => (
				<article key={item.target.id}>
					<label>
						<input
							type="checkbox"
							checked={selected.includes(item.target.id)}
							disabled={
								busy || (!canConnect(item) && !["review_required", "failed"].includes(item.state))
							}
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
							? item.matches.length
								? "fill this saved login in your existing Chrome session; review OAuth permissions in Chrome"
								: "open sign-in in your existing Chrome session; no saved credentials will be used"
							: item.target.authType === "browser"
								? "sign in to the selected browser account"
								: "configure and verify the listed credential fields"}
						. Approval applies only to these mappings.
					</p>
					{!busy &&
						view.workflowVersion === 2 &&
						(["matching", "review_required"].includes(item.state) ||
							(item.target.authType === "oauth2" &&
								!item.matches.length &&
								item.state === "user_action_required")) &&
						!blocked && (
							<button
								onClick={() => {
									setEditing(item.target.id);
									setDraft(
										item.matches.length
											? item.matches
											: [
													{
														field: ["browser", "oauth2"].includes(item.target.authType)
															? "login"
															: "apiKey",
														source: { kind: "bitwarden", credentialId: "" },
													},
												],
									);
									act("choose", undefined, { itemId: item.target.id });
								}}
							>
								Choose or change credential
							</button>
						)}
					{editing === item.target.id && !blocked && (
						<div className="broker-matches">
							<label>
								Search saved credentials
								<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
							</label>
							<button disabled={busy} onClick={() => act("candidates", undefined, { query })}>
								Search
							</button>
							{draft.map((match, index) => (
								<div key={index} className="broker-field">
									<label>
										Field
										<input
											value={match.field}
											readOnly={["browser", "oauth2"].includes(item.target.authType)}
											onChange={(e) =>
												setDraft((d) =>
													d.map((m, n) => (n === index ? { ...m, field: e.target.value } : m)),
												)
											}
										/>
									</label>
									<label>
										Saved credential
										<select
											value={JSON.stringify(match.source)}
											onChange={(e) => {
												const candidate = candidates?.items.find(
													(c) => JSON.stringify(c.source) === e.target.value,
												);
												if (candidate)
													setDraft((d) =>
														d.map((m, n) => (n === index ? { field: m.field, ...candidate } : m)),
													);
											}}
										>
											<option value={JSON.stringify(match.source)}>
												{match.label ?? "Select a credential"}
											</option>
											{candidates?.items
												.filter((c) =>
													["browser", "oauth2"].includes(item.target.authType)
														? c.source.kind === "bitwarden"
														: c.source.kind === "doppler",
												)
												.map((c) => (
													<option key={JSON.stringify(c.source)} value={JSON.stringify(c.source)}>
														{c.label}
													</option>
												))}
										</select>
									</label>
									{draft.length > 1 && (
										<button onClick={() => setDraft((d) => d.filter((_, n) => n !== index))}>
											Remove field
										</button>
									)}
								</div>
							))}
							{!["browser", "oauth2"].includes(item.target.authType) && (
								<button
									onClick={() =>
										setDraft((d) => [
											...d,
											{ field: "", source: { kind: "bitwarden", credentialId: "" } },
										])
									}
								>
									Add field
								</button>
							)}
							{candidates?.nextCursor !== undefined && (
								<button
									disabled={busy}
									onClick={() =>
										act("candidates", undefined, { query, cursor: candidates.nextCursor })
									}
								>
									More credentials
								</button>
							)}
							<button
								disabled={
									busy ||
									draft.some(
										(m) => !m.field || (m.source.kind === "bitwarden" && !m.source.credentialId),
									)
								}
								onClick={() => {
									act("propose", undefined, { itemId: item.target.id, matches: draft });
									setEditing(undefined);
								}}
							>
								Use selected matches
							</button>
							<button onClick={() => setEditing(undefined)}>Close</button>
						</div>
					)}
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
						{
							{
								matching: "Choose credential",
								review_required: "Ready for approval",
								running: item.target.authType === "oauth2" ? "Opening Chrome" : "Connecting",
								user_action_required: "Waiting for you",
								verifying: "Verifying",
								connected: "Connected",
								failed: "Needs attention",
								cancelled: "Cancelled",
								expired: "Expired",
							}[item.state]
						}{" "}
						— {item.message}
					</p>
					{item.browserTargetId &&
						["running", "user_action_required", "verifying"].includes(item.state) && (
							<button
								disabled={busy}
								onClick={() =>
									act("browser", undefined, { itemId: item.target.id, operation: "focus" })
								}
							>
								Bring Chrome forward
							</button>
						)}
				</article>
			))}
			{error && <p role="alert">{error}</p>}
			<div className="actions">
				{view.items.some(canConnect) && (
					<button
						disabled={
							busy ||
							!!blocked ||
							!view.items.some((i) => canConnect(i) && selected.includes(i.target.id))
						}
						onClick={() =>
							act(
								"connect",
								view.items
									.filter((i) => canConnect(i) && selected.includes(i.target.id))
									.map((i) => i.target.id),
							)
						}
					>
						Continue in Chrome
					</button>
				)}
				<button
					disabled={
						busy ||
						!!blocked ||
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
			<p>MFA, passkeys, CAPTCHA and OAuth consent remain yours to complete in Chrome.</p>
		</section>
	);
}
