import { type CredentialCandidate, brokerHandoff } from "@repo/project-protocol/credential-broker";
import { BrokerReviewCard, type BrokerView } from "@repo/project-protocol/mcp/broker-approval-card";
import { useEffect, useState } from "react";

import { Modal } from "./Dialogs";
import { invoke } from "./types";

import "../../../../packages/project-protocol/src/mcp/ui/broker/style.css";
export function BrokerPanel() {
	const [candidates, setCandidates] = useState<{
		items: CredentialCandidate[];
		nextCursor?: number;
	}>();
	const [opened, setOpened] = useState(false);
	const [view, setView] = useState<BrokerView & { principalId: string; principalName?: string }>(),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[dismissed, setDismissed] = useState("");
	useEffect(
		() =>
			window.laplaceDesktop.onEvent((e) => {
				if (e.event === "broker-focus") {
					setDismissed("");
					setOpened(true);
				}
			}),
		[],
	);
	useEffect(() => {
		let stopped = false;
		async function poll() {
			try {
				const list =
					await invoke<Array<BrokerView & { principalId: string; principalName?: string }>>(
						"broker.list",
					);
				const pending = list.find((v) =>
					v.items.some((i) =>
						[
							"matching",
							"review_required",
							"running",
							"user_action_required",
							"verifying",
						].includes(i.state),
					),
				);
				if (!stopped && !busy)
					setView((previous) => pending ?? list.find((v) => v.id === previous?.id));
			} catch {
				/* Older helpers do not expose brokering. */
			}
		}
		void poll();
		const timer = setInterval(() => void poll(), 2000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [busy]);
	async function act(action: string, itemIds?: string[], extra: Record<string, unknown> = {}) {
		if (!view || busy) return;
		setBusy(true);
		setError("");
		try {
			const call = (command: unknown) =>
				invoke<{
					view: BrokerView;
					capability?: string;
					candidates?: CredentialCandidate[];
					nextCursor?: number;
				}>("broker.call", {
					principalId: view.principalId,
					requestId: crypto.randomUUID(),
					command: { sessionId: view.id, ...(command as object) },
				});
			if (action === "choose") {
				const result = await call({ action: "match", ...extra });
				setView({ ...result.view, principalId: view.principalId });
				const data = await call({ action: "candidates", query: "" });
				setCandidates({ items: data.candidates ?? [], nextCursor: data.nextCursor });
			} else if (action === "authorize") {
				await invoke("broker.authorizeAssistant", { principalId: view.principalId });
				setError("Assistant authorized for matching. Ask it to list candidates again.");
			} else if (action === "retry") {
				const targets = view.items
					.filter((i) => itemIds?.includes(i.target.id) && i.state === "failed")
					.map((i) => ({ ...i.target, id: crypto.randomUUID() }));
				await navigator.clipboard.writeText(
					brokerHandoff(crypto.randomUUID(), view.accountId ?? "local", targets) +
						"\nInspect prior uncertain outcomes first; these are the only selected retries. Require a fresh review.",
				);
				setError("Retry request copied. Paste it into your assistant to prepare a fresh review.");
			} else if (action === "approve" || action === "connect") {
				const fresh = await call({ action: "review" });
				if (fresh.view.revision !== view.revision) throw Error("Review changed.");
				const result = await call({ action, capability: fresh.capability, itemIds });
				setView({ ...result.view, principalId: view.principalId });
			} else {
				const result = await call({ action, ...extra });
				if (result.view) setView({ ...result.view, principalId: view.principalId });
				if (action === "candidates")
					setCandidates((previous) => ({
						items: extra.cursor
							? [...(previous?.items ?? []), ...(result.candidates ?? [])]
							: (result.candidates ?? []),
						nextCursor: result.nextCursor,
					}));
			}
		} catch {
			setError("Review expired or access changed. Ask your assistant to refresh.");
		} finally {
			setBusy(false);
		}
	}
	return opened && view && dismissed !== view.id + ":" + view.revision ? (
		<Modal title="Credential review" close={() => setDismissed(view.id + ":" + view.revision)}>
			<p>{view.principalName ?? "Connected assistant"}</p>
			{view.principalId.startsWith("hosted:") && view.items.some((i) => i.state === "matching") && (
				<button disabled={busy} onClick={() => void act("authorize")}>
					Allow this assistant to match credential metadata
				</button>
			)}
			<BrokerReviewCard
				view={view}
				busy={busy}
				error={error}
				candidates={candidates}
				act={(a, ids, extra) => void act(a, ids, extra)}
			/>
		</Modal>
	) : null;
}
