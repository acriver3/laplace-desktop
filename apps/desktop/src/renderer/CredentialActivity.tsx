import type { BrokerView } from "@repo/project-protocol/mcp/broker-approval-card";
import { useEffect, useState } from "react";

import { invoke } from "./types";
export function CredentialActivity() {
	const [sessions, setSessions] = useState<
		Array<BrokerView & { principalId: string; principalName?: string }>
	>([]);
	useEffect(() => {
		let active = true;
		const load = () =>
			void invoke<typeof sessions>("broker.list")
				.then((value) => {
					if (active) setSessions(Array.isArray(value) ? value : []);
				})
				.catch(() => {});
		load();
		const timer = setInterval(load, 3000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, []);
	return (
		<section className="credential-history" aria-label="Recent credential requests">
			<h2>Recent requests</h2>
			{!sessions.length && (
				<p>No connection requests yet. Start from Connections or ask your assistant.</p>
			)}
			{[...sessions]
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, 20)
				.map((session) => (
					<article key={session.id}>
						<strong>{session.principalName ?? "Connected assistant"}</strong>
						{session.items.map((item) => (
							<p key={item.target.id}>
								{item.target.label} · {item.state.replaceAll("_", " ")}
								<br />
								{item.message}
							</p>
						))}
						{session.items.some((i) =>
							["matching", "review_required", "user_action_required"].includes(i.state),
						) && (
							<button
								onClick={() =>
									void invoke("broker.call", {
										principalId: session.principalId,
										requestId: crypto.randomUUID(),
										command: { action: "desktop", sessionId: session.id },
									})
								}
							>
								Open review
							</button>
						)}
					</article>
				))}
		</section>
	);
}
