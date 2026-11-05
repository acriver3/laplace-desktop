import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupNotificationText } from "@repo/project-protocol/setup-notifications";
import { expect, it, vi } from "vitest";

import { CatalogInstaller, type CatalogJob } from "@repo/local-runtime/catalog";
import { syncSetupNotifications } from "../src/main/setup-notifications";
import type { DesktopSnapshot } from "@repo/local-runtime/shared/helper-contracts";
const owner = {
	accountId: "workspace-a",
	installationId: randomUUID(),
	origin: "https://connect.withlaplace.com",
};
const job = (): CatalogJob => ({
	id: randomUUID(),
	catalogId: "yc",
	connectorName: "Y Combinator",
	serverId: "pc_private",
	kind: "authenticate",
	status: "completed",
	stage: "complete",
	message: "private-detail",
	error: "secret-canary",
	startedAt: new Date().toISOString(),
	finishedAt: new Date().toISOString(),
	notificationOwner: owner,
});
const snapshot = (jobs: CatalogJob[]) => ({ ...owner, mode: "linked", jobs }) as DesktopSnapshot;
it("queues failures, retries safely, sends only safe result fields, and acknowledges accepted IDs", async () => {
	const result = job(),
		acknowledge = vi.fn(),
		send = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue({ accepted: [result.id, "unknown"] });
	const options = { snapshot: snapshot([result]), current: () => true, send, acknowledge };
	await expect(syncSetupNotifications(options)).rejects.toThrow("offline");
	expect(acknowledge).not.toHaveBeenCalled();
	await syncSetupNotifications(options);
	expect(acknowledge).toHaveBeenCalledWith(owner, [result.id]);
	expect(JSON.stringify(send.mock.calls)).not.toMatch(/private-detail|secret-canary|pc_private/);
	expect(setupNotificationText(send.mock.calls[1][0].results[0], "My Mac").title).toBe(
		"Y Combinator connected",
	);
});
it("never sends unowned, other-account, other-installation, running, cancelled or delivered jobs", async () => {
	const send = vi.fn(),
		acknowledge = vi.fn();
	const jobs: CatalogJob[] = [
		{ ...job(), notificationOwner: undefined },
		{ ...job(), notificationOwner: { ...owner, accountId: "other" } },
		{ ...job(), notificationOwner: { ...owner, installationId: randomUUID() } },
		{ ...job(), status: "running" },
		{ ...job(), status: "cancelled" },
		{ ...job(), notificationDelivered: true },
	];
	await syncSetupNotifications({
		snapshot: snapshot(jobs),
		current: () => true,
		send,
		acknowledge,
	});
	expect(send).not.toHaveBeenCalled();
});
it("does not acknowledge a response after account/profile changes", async () => {
	const result = job();
	let current = true;
	const acknowledge = vi.fn();
	await syncSetupNotifications({
		snapshot: snapshot([result]),
		current: () => current,
		send: async () => {
			current = false;
			return { accepted: [result.id] };
		},
		acknowledge,
	});
	expect(acknowledge).not.toHaveBeenCalled();
});
it("keeps outbox ownership and acknowledgement across restarts without importing legacy jobs", async () => {
	const root = await mkdtemp(join(tmpdir(), "laplace-notifications-"));
	const result = job(),
		legacy = { ...job(), notificationOwner: undefined },
		interrupted = { ...job(), status: "running" as const };
	const create = () =>
		new CatalogInstaller({} as never, { root, resources: root, nodePath: process.execPath });
	try {
		await writeFile(join(root, "catalog-jobs.json"), JSON.stringify([result, legacy, interrupted]));
		const first = create();
		await first.list();
		expect(first.jobs().find((row) => row.id === interrupted.id)?.status).toBe("failed");
		expect(first.jobs().find((row) => row.id === interrupted.id)?.finishedAt).toBeTruthy();
		await first.acknowledgeNotifications({ ...owner, accountId: "other" }, [result.id]);
		expect(first.jobs()[0]?.notificationDelivered).not.toBe(true);
		await first.acknowledgeNotifications(owner, [result.id]);
		const restarted = create();
		await restarted.list();
		expect(restarted.jobs().find((row) => row.id === result.id)?.notificationDelivered).toBe(true);
		expect(restarted.jobs().find((row) => row.id === legacy.id)?.notificationOwner).toBeUndefined();
		expect(await readFile(join(root, "catalog-jobs.json"), "utf8")).not.toContain("secret-canary");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
