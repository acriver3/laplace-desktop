import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { browserProviders } from "@repo/browser-runtime/browser-approval";
import { z } from "zod";

import { browserSetupTools, verifyBrowserConfiguration, slackSettings } from "./browser-catalog";
import { serverConfig, type ServerConfig } from "./config";
import { Supervisor } from "./supervisor";

export const browserMigration = z
	.object({
		id: z.string().uuid(),
		serverId: z.string(),
		catalogId: z.string(),
		state: z.enum(["prepared", "committing", "complete", "cancelled"]),
		previous: serverConfig,
		candidate: serverConfig,
		createdAt: z.string().datetime(),
		owner: z.string().optional(),
		requestId: z.string().uuid().optional(),
		previousInstallation: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export type BrowserMigration = z.infer<typeof browserMigration>;
export function migrationCandidate(previous: ServerConfig, candidate: ServerConfig) {
	if (candidate.transport !== "stdio" || !candidate.managedBrowser)
		throw Error("Missing managed browser artifact.");
	const settings =
		previous.transport === "stdio" && candidate.managedBrowser.provider === "slack-tethered"
			? Object.fromEntries(
					Object.entries(previous.env).filter(([key]) => slackSettings.includes(key)),
				)
			: {};
	return serverConfig.parse({
		...candidate,
		id: previous.id,
		name: previous.name,
		generation: previous.generation,
		enabled: previous.enabled,
		...(previous.enabledTools ? { enabledTools: previous.enabledTools } : {}),
		env: { ...candidate.env, ...settings },
	});
}
export function prepareBrowserMigration(
	previous: ServerConfig,
	candidate: ServerConfig,
): BrowserMigration {
	return browserMigration.parse({
		id: randomUUID(),
		serverId: previous.id,
		catalogId: candidate.managedBrowser?.catalogId,
		state: "prepared",
		previous,
		candidate: migrationCandidate(previous, candidate),
		createdAt: new Date().toISOString(),
	});
}

/** Approval and read verification run in an isolated supervisor. The active
 * connection remains paused with its original configuration until commit. */
export class BrowserMigrationStage {
	readonly config: ServerConfig;
	private supervisor: Supervisor;
	private invocations = new WeakSet<object>();
	constructor(
		root: string,
		private resources: string,
		record: BrowserMigration,
	) {
		this.config = { ...record.candidate, enabled: true };
		this.supervisor = new Supervisor(
			join(root, "browser-migrations", record.id),
			resources,
			() => {},
			async () => {},
			async (invocation) => {
				if (!this.invocations.has(invocation))
					throw Error("Migration only permits approved setup checks.");
			},
		);
		this.supervisor.configure([this.config]);
	}
	async call(tool: string, input: Record<string, unknown>, signal: AbortSignal) {
		const receipt = await verifyBrowserConfiguration(this.resources, this.config);
		if (
			![...browserSetupTools, browserProviders[receipt.provider].verify].includes(tool) ||
			(Object.keys(input).length &&
				!["laplace_browser_authorize", "laplace_browser_focus"].includes(tool))
		)
			throw Error("Migration permits only browser approval and named read verification.");
		await this.supervisor.start(this.config.id);
		const state = this.supervisor.states().find((state) => state.id === this.config.id);
		if (!state?.revision) throw Error("Migration candidate did not initialize.");
		const invocation = { localId: this.config.id, tool, input, revision: state.revision };
		this.invocations.add(invocation);
		const controller = new AbortController(),
			abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		try {
			return await this.supervisor.callBrowserSetup(invocation, Date.now() + 180000, controller);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	async close() {
		await this.supervisor.shutdown();
	}
}
