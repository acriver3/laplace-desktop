import { credentialInput } from "@repo/project-protocol/credentials";
import { z } from "zod";

import type { CredentialBroker, CredentialPrincipal } from "./credentials";
import type { DesktopManager } from "./manager";

const jobSchema = z.object({
	id: z.string().uuid(),
	principalId: z.string().regex(/^hosted:[a-f0-9]{64}$/),
	clientName: z.string().max(200),
	input: credentialInput,
});
/** Outbound polling only. Claimed work is never automatically replayed after helper restart. */
export function startCredentialRelay(manager: DesktopManager, broker: CredentialBroker) {
	const jobs = new Map<
		string,
		{ principal: CredentialPrincipal; input: z.infer<typeof credentialInput> }
	>();
	let busy = false,
		stopped = false;
	const tick = async () => {
		if (busy || stopped) return;
		busy = true;
		try {
			const settings = broker.snapshot().settings;
			if (!settings.enabled || !settings.hosted) {
				broker.hostedState = "disabled";
				jobs.clear();
				return;
			}
			const api = await manager.credentialRelayApi();
			const result = z
				.object({ jobs: z.array(jobSchema).max(10) })
				.parse(await api.post("credentials/poll", { runId: manager.runId }));
			broker.hostedState = "ready";
			for (const job of result.jobs) {
				if (stopped) return;
				const principal: CredentialPrincipal = {
					id: job.principalId,
					name: job.clientName,
					hosted: true,
					authorize: async () => {
						const api = await manager.credentialRelayApi();
						z.object({ authorized: z.literal(true) }).parse(
							await api.post("credentials/authorize", { id: job.id, runId: manager.runId }),
						);
					},
				};
				jobs.set(job.id, { principal, input: job.input });
				await broker.call(principal, job.input).catch(() => {});
			}
			for (const [id, job] of jobs) {
				if (stopped) return;
				try {
					const result = (await broker.call(job.principal, {
						action: "result",
						requestId: id,
					})) as { status: string };
					if (["pending", "running"].includes(result.status)) continue;
					await api.post("credentials/result", { id, runId: manager.runId, result });
					jobs.delete(id);
				} catch {
					await broker
						.call({ ...job.principal, authorize: () => {} }, { action: "cancel", requestId: id })
						.catch(() => {});
					jobs.delete(id);
				}
			}
		} catch {
			broker.hostedState = "unavailable";
			// Fail closed on loss of linked authorization. Do not log request payloads or exceptions.
			for (const [id, job] of jobs)
				await broker
					.call({ ...job.principal, authorize: () => {} }, { action: "cancel", requestId: id })
					.catch(() => {});
			jobs.clear();
		} finally {
			busy = false;
		}
	};
	const timer = setInterval(() => void tick(), 2000);
	timer.unref();
	return () => {
		stopped = true;
		clearInterval(timer);
		jobs.clear();
	};
}
