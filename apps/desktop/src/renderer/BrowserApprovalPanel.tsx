import {
	ApprovalCard,
	approvalError,
	refreshedApprovalCapability,
	type ApprovalView,
} from "@repo/project-protocol/mcp/browser-approval-card";
import { useEffect, useRef, useState } from "react";

import { Modal } from "./Dialogs";
import { invoke } from "./types";

import "../../../../packages/project-protocol/src/mcp/ui/browser/style.css";
export function BrowserApprovalPanel({ requestId }: { requestId?: string }) {
	const [view, setView] = useState<ApprovalView>(),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[dismissed, setDismissed] = useState<string>();
	const locked = useRef(false),
		polling = useRef(false),
		epoch = useRef(0);
	function receive(value: unknown) {
		const r = value as { view: ApprovalView; capabilities: Record<string, string> };
		setView(r.view);
	}
	useEffect(() => {
		let stopped = false;
		async function refresh() {
			if (locked.current || polling.current) return;
			polling.current = true;
			const version = epoch.current;
			try {
				const list = (await invoke("browser.list", {})) as ApprovalView[];
				const id = requestId ?? list.find((v) => v.state !== "connected")?.requestId;
				if (id) {
					const result = await invoke("browser.review", { requestId: id });
					if (!stopped && version === epoch.current) receive(result);
				} else if (!stopped) setView(undefined);
			} catch {
				if (!stopped) setError("Browser connection unavailable.");
			} finally {
				polling.current = false;
			}
		}
		void refresh();
		const timer = setInterval(() => void refresh(), 1500);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [requestId]);
	async function act(action: string, selection?: string) {
		if (!view || locked.current) return;
		locked.current = true;
		epoch.current++;
		setBusy(true);
		setError("");
		try {
			let capability: string | undefined;
			if (action === "approve") {
				const fresh = (await invoke("browser.review", { requestId: view.requestId })) as {
					view: ApprovalView;
					capabilities: Record<string, string>;
				};
				receive(fresh);
				capability = refreshedApprovalCapability(view, selection!, fresh.view, fresh.capabilities);
			}
			const value =
				action === "approve"
					? await invoke("browser.approve", {
							requestId: view.requestId,
							capability,
						})
					: action === "focus"
						? await invoke("browser.focus", { requestId: view.requestId, profileId: selection! })
						: await invoke("browser.cancel", { requestId: view.requestId });
			receive(value);
		} catch (e) {
			setError(approvalError(e));
		} finally {
			locked.current = false;
			setBusy(false);
		}
	}
	return view && dismissed !== view.requestId ? (
		<Modal
			title="Browser connection"
			close={() => {
				if (!busy) setDismissed(view.requestId);
			}}
		>
			<div className="desktop-browser-approval">
				<ApprovalCard view={view} busy={busy} error={error} act={(a, s) => void act(a, s)} />
			</div>
		</Modal>
	) : null;
}
