import {
	setupNotificationResult,
	type SetupNotificationOwner,
} from "@repo/project-protocol/setup-notifications";

import type { CatalogJob } from "@repo/local-runtime/catalog";
import type { DesktopSnapshot } from "../shared/helper-contracts";

/** The persisted job journal is the outbox; only acknowledged jobs are hidden. */
export async function syncSetupNotifications(options: {
	snapshot: DesktopSnapshot;
	current: () => boolean;
	send: (body: {
		accountId: string;
		installationId: string;
		results: Array<ReturnType<typeof setupNotificationResult.parse>>;
	}) => Promise<unknown>;
	acknowledge: (owner: SetupNotificationOwner, ids: string[]) => Promise<unknown>;
}) {
	const { snapshot } = options;
	if (
		snapshot.mode !== "linked" ||
		!snapshot.accountId ||
		!snapshot.installationId ||
		!options.current()
	)
		return;
	const owner = {
		accountId: snapshot.accountId,
		installationId: snapshot.installationId,
		origin: snapshot.origin,
	};
	const results = snapshot.jobs
		.flatMap((value) => {
			const job = value as CatalogJob;
			if (
				job.notificationDelivered ||
				job.notificationOwner?.accountId !== owner.accountId ||
				job.notificationOwner?.installationId !== owner.installationId ||
				job.notificationOwner?.origin !== owner.origin
			)
				return [];
			const parsed = setupNotificationResult.safeParse({
				jobId: job.id,
				connectorName: job.connectorName,
				operation: job.kind,
				status: job.status,
				finishedAt: job.finishedAt,
			});
			return parsed.success ? [parsed.data] : [];
		})
		.slice(0, 50);
	if (!results.length || !options.current()) return;
	const response = await options.send({
		accountId: owner.accountId,
		installationId: owner.installationId,
		results,
	});
	if (
		!options.current() ||
		!response ||
		typeof response !== "object" ||
		!("accepted" in response) ||
		!Array.isArray(response.accepted)
	)
		return;
	const accepted = response.accepted;
	const ids = results.map((result) => result.jobId).filter((id) => accepted.includes(id));
	if (ids.length) await options.acknowledge(owner, ids);
}
