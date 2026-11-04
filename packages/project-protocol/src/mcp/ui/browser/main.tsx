import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { callTool, request, subscribe } from "../bridge";
import {
	ApprovalCard,
	approvalError,
	refreshedApprovalCapability,
	type ApprovalView,
} from "./ApprovalCard";
function App() {
	const [view, setView] = useState<ApprovalView>(),
		[busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const locked = useRef(false),
		polling = useRef(false),
		epoch = useRef(0),
		notified = useRef("");
	function receive(result: { structuredContent?: unknown; _meta?: Record<string, unknown> }) {
		const v = result.structuredContent as ApprovalView | undefined;
		if (!v?.requestId || !Array.isArray(v.candidates)) return;
		setView(v);
		if (v.state === "connected" && notified.current !== v.requestId) {
			notified.current = v.requestId;
			void request("ui/update-model-context", {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							requestId: v.requestId,
							state: "connected",
							provider: v.provider,
							workspace: v.workspace,
						}),
					},
				],
			}).catch(() => {});
		}
	}
	useEffect(() => subscribe(receive), []);
	const requestId = view?.requestId,
		state = view?.state;
	useEffect(() => {
		if (!requestId || ["cancelled", "expired"].includes(state ?? "")) return;
		const timer = setInterval(() => {
			if (locked.current || polling.current) return;
			polling.current = true;
			const version = epoch.current;
			void callTool("local_connectors_browser_review", { requestId })
				.then((result) => {
					if (version === epoch.current) receive(result);
				})
				.catch(() => setError("Could not refresh. Check that Laplace Desktop is running."))
				.finally(() => {
					polling.current = false;
				});
		}, 1500);
		return () => clearInterval(timer);
	}, [requestId, state]);
	async function act(action: string, selection?: string) {
		if (!view || locked.current) return;
		locked.current = true;
		epoch.current++;
		setBusy(true);
		setError("");
		try {
			let capability: string | undefined;
			if (action === "approve") {
				const fresh = await callTool("local_connectors_browser_review", {
					requestId: view.requestId,
				});
				receive(fresh);
				capability = refreshedApprovalCapability(
					view,
					selection!,
					fresh.structuredContent as ApprovalView,
					(fresh._meta?.browserApprovalCapabilities ?? {}) as Record<string, string>,
				);
			}
			receive(
				await callTool("local_connectors_browser_" + action, {
					requestId: view.requestId,
					...(action === "approve"
						? { capability }
						: action === "focus"
							? { profileId: selection }
							: {}),
				}),
			);
		} catch (e) {
			setError(approvalError(e));
		} finally {
			locked.current = false;
			setBusy(false);
		}
	}
	return view ? (
		<ApprovalCard view={view} busy={busy} error={error} act={(a, s) => void act(a, s)} />
	) : (
		<p role="status">Finding your browser connection…</p>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
