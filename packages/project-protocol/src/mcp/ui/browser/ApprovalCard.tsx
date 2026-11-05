import { useState } from "react";

export interface ApprovalView {
	requestId: string;
	provider: string;
	workspace: string;
	signInUrl?: string;
	scopes: readonly string[];
	state: string;
	message: string;
	candidates: Array<{
		id: string;
		profileId: string;
		profileLabel: string;
		revision: string;
		identity: { userId: string; workspace: string; accountLabel?: string };
	}>;
	profiles?: Array<{ profileId: string; profileLabel: string }>;
	selectedId?: string;
}
/** A click may refresh an expired token, but must never approve a different review. */
export function refreshedApprovalCapability(
	shown: ApprovalView,
	selection: string,
	fresh: ApprovalView,
	capabilities: Record<string, string>,
) {
	const before = shown.candidates.find((c) => c.id === selection);
	const after = fresh.candidates.find((c) => c.id === selection);
	if (
		!before ||
		!after ||
		fresh.state !== "approval_required" ||
		shown.requestId !== fresh.requestId ||
		shown.provider !== fresh.provider ||
		shown.workspace !== fresh.workspace ||
		JSON.stringify(shown.scopes) !== JSON.stringify(fresh.scopes) ||
		JSON.stringify(before) !== JSON.stringify(after) ||
		!capabilities[selection]
	)
		throw Error("The account or access changed. Review the updated details before approving.");
	return capabilities[selection];
}
export function approvalError(error: unknown) {
	return error instanceof Error
		? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
		: "Could not complete the request. Refresh the review and try again.";
}
export function ApprovalCard({
	view,
	busy,
	error,
	act,
	openSignIn,
}: {
	view: ApprovalView;
	busy: boolean;
	error: string;
	act: (action: string, selection?: string) => void;
	openSignIn?: (url: string) => void;
}) {
	const [chosen, setChosen] = useState("");
	const selected = view.candidates.some((c) => c.id === chosen) ? chosen : (view.selectedId ?? "");
	const connected = view.state === "connected",
		ended = ["cancelled", "expired"].includes(view.state);
	return (
		<section className="browser-approval" aria-label="Browser connection approval">
			<p className="eyebrow">LAPLACE · BROWSER CONNECTION</p>
			<h2>
				{connected ? "Connected to " : "Connect to "}
				{view.provider}
			</h2>
			<p className="workspace">{view.workspace}</p>
			{view.candidates.length > 0 && (
				<label>
					Account
					<select
						aria-label="Account"
						value={selected}
						disabled={busy || connected}
						onChange={(e) => setChosen(e.target.value)}
					>
						<option value="" disabled>
							Choose an account
						</option>
						{view.candidates.map((c) => (
							<option key={c.id} value={c.id}>
								{c.identity.accountLabel ?? c.identity.userId} · {c.profileLabel}
							</option>
						))}
					</select>
				</label>
			)}
			<ul aria-label="Requested access">
				{view.scopes.map((scope) => (
					<li key={scope}>{scope}</li>
				))}
			</ul>
			<p role="status">{view.message}</p>
			{error && <p role="alert">{error}</p>}
			{!ended && (
				<div className="actions">
					{view.state === "sign_in_required" && view.signInUrl && (
						<a
							href={view.signInUrl}
							target="_blank"
							rel="noreferrer"
							onClick={
								openSignIn
									? (event) => {
											event.preventDefault();
											openSignIn(view.signInUrl!);
										}
									: undefined
							}
						>
							Sign in to {view.provider}
						</a>
					)}
					{view.state === "approval_required" && (
						<button
							className="primary"
							disabled={busy || !selected}
							onClick={() => act("approve", selected)}
						>
							Approve connection
						</button>
					)}
					{view.state === "sign_in_required" &&
						(view.profiles ?? []).map((p) => (
							<button key={p.profileId} disabled={busy} onClick={() => act("focus", p.profileId)}>
								Finish signing in · {p.profileLabel}
							</button>
						))}
					<button disabled={busy} onClick={() => act("cancel")}>
						{connected ? "Disconnect" : "Cancel"}
					</button>
				</div>
			)}
			{!ended && !connected && (
				<small>Approval is remembered for this account and access. Disconnect at any time.</small>
			)}
		</section>
	);
}
