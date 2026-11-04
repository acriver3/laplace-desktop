import { useEffect, useState, useRef, useEffectEvent } from "react";
import { createRoot } from "react-dom/client";

import { callTool, subscribe, askWithContext } from "../bridge";
import { BrokerReviewCard, type BrokerView } from "./Card";
function App() {
	const [view, setView] = useState<BrokerView>(),
		[busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const routing = useRef<{ tool: string; accountId?: string; installationId?: string }>({
		tool: "credential_broker",
	});
	const locked = useRef(false);
	function receive(result: { structuredContent?: unknown; _meta?: Record<string, unknown> }) {
		const value = result.structuredContent as { view?: BrokerView } | undefined;
		if (value?.view) setView(value.view);
		const route = result._meta?.brokerRouting as typeof routing.current | undefined;
		if (route)
			routing.current = {
				tool: route.tool.replace(/_(show|review|approve|prepare)$/, ""),
				accountId: route.accountId,
				installationId: route.installationId,
			};
	}
	useEffect(() => subscribe(receive), []);
	async function request(action: string, extra: Record<string, unknown> = {}) {
		const route = routing.current;
		const tool =
			route.tool + (action === "approve" ? "_approve" : action === "review" ? "_review" : "");
		const input = {
			accountId: route.accountId,
			installationId: route.installationId,
			requestId: crypto.randomUUID(),
			command: { action, sessionId: view!.id, ...extra },
		};
		let result = await callTool(tool, input);
		for (let attempt = 0; attempt < 60; attempt++) {
			const status = (result.structuredContent as { status?: string } | undefined)?.status;
			if (["failed", "expired", "unavailable", "cancelled"].includes(status ?? ""))
				throw Error("Request unavailable.");
			if (!["queued", "delivered", "running"].includes(status ?? "")) {
				receive(result);
				return result;
			}
			await new Promise((resolve) => setTimeout(resolve, 1500));
			result = await callTool(tool, {
				accountId: route.accountId,
				installationId: route.installationId,
				requestId: input.requestId,
				poll: true,
			});
		}
		throw Error("Desktop did not respond. Refresh to inspect the request.");
	}
	const pollStatus = useEffectEvent(() => {
		if (!locked.current) void act("status");
	});
	useEffect(() => {
		if (
			!view?.items.some((i) => ["running", "verifying", "user_action_required"].includes(i.state))
		)
			return;
		const timer = setInterval(() => {
			pollStatus();
		}, 3000);
		return () => clearInterval(timer);
	}, [view]);
	async function act(action: string, ids?: string[]) {
		if (!view || locked.current) return;
		locked.current = true;
		setBusy(true);
		setError("");
		try {
			if (action === "retry") {
				await askWithContext(
					"Prepare a new broker session for only these explicitly selected failed items. Inspect existing connection outcomes first. Propose current credential matches and require a fresh review; never retry a business action.",
					{
						targets: view.items
							.filter((i) => ids?.includes(i.target.id) && i.state === "failed")
							.map((i) => i.target),
					},
				);
			} else if (action === "approve") {
				const currentRevision = view.revision;
				const fresh = await request("review");
				const next = (fresh.structuredContent as { view: BrokerView }).view;
				if (next.revision !== currentRevision)
					throw Error("The review changed. Check the updated matches.");
				const capability = fresh._meta?.brokerCapability;
				if (typeof capability !== "string") throw Error("Approval unavailable. Refresh this card.");
				const approved = await request("approve", { itemIds: ids, capability });
				await askWithContext(
					"I approved the selected credential mappings. Continue this broker session, inspect status, and pause for any MFA or provider consent. Do not replay completed submissions or business actions.",
					approved.structuredContent,
				).catch(() => {});
			} else await request(action);
		} catch {
			setError(
				"Could not complete this request. Refresh this card to check its status before retrying.",
			);
		} finally {
			locked.current = false;
			setBusy(false);
		}
	}
	return view ? (
		<BrokerReviewCard view={view} busy={busy} error={error} act={(a, ids) => void act(a, ids)} />
	) : (
		<p>Ask your assistant to open the credential review.</p>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
