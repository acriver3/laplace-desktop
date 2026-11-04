import { brokerHandoff } from "@repo/project-protocol/credential-broker";
import { BrokerReviewCard, type BrokerView } from "@repo/project-protocol/mcp/broker-approval-card";
import { useEffect, useState } from "react";

import { Modal } from "./Dialogs";
import { invoke } from "./types";

import "../../../../packages/project-protocol/src/mcp/ui/broker/style.css";
export function BrokerPanel() {
	const [view, setView] = useState<BrokerView & { principalId: string; principalName?: string }>(),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[dismissed, setDismissed] = useState("");
	useEffect(
		() =>
			window.laplaceDesktop.onEvent((e) => {
				if (e.event === "broker-focus") setDismissed("");
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
	async function act(action: string, itemIds?: string[]) {
		if (!view || busy) return;
		setBusy(true);
		setError("");
		try {
			const call = (command: unknown) =>
				invoke<{ view: BrokerView; capability?: string }>("broker.call", {
					principalId: view.principalId,
					requestId: crypto.randomUUID(),
					command: { sessionId: view.id, ...(command as object) },
				});
			if (action === "authorize") {
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
			} else if (action === "approve") {
				const fresh = await call({ action: "review" });
				if (fresh.view.revision !== view.revision) throw Error("Review changed.");
				await call({ action, capability: fresh.capability, itemIds });
			} else await call({ action });
		} catch {
			setError("Review expired or access changed. Ask your assistant to refresh.");
		} finally {
			setBusy(false);
		}
	}
	return view && dismissed !== view.id + ":" + view.revision ? (
		<Modal title="Credential review" close={() => setDismissed(view.id + ":" + view.revision)}>
			<p>{view.principalName ?? "Connected assistant"}</p>
			{view.principalId.startsWith("hosted:") && view.items.some((i) => i.state === "matching") && (
				<button disabled={busy} onClick={() => void act("authorize")}>
					Allow this assistant to match credential metadata
				</button>
			)}
			<BrokerReviewCard view={view} busy={busy} error={error} act={(a, ids) => void act(a, ids)} />
		</Modal>
	) : null;
}
