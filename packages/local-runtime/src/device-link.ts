import { LocalApi } from "@repo/local-mcp-core/api";
import { z } from "zod";

import type { DesktopManager } from "./manager";

const started = z
	.object({
		pollCode: z.string(),
		approvalCode: z.string(),
		verificationUrl: z.string().url(),
		expiresIn: z.number().int().positive().max(900),
		interval: z.number(),
	})
	.strict();
const linked = z
	.object({ status: z.literal("linked"), installationId: z.string().uuid(), accountId: z.string() })
	.strict();

/** Browser-approved linking for hosts without a Laplace web session (CLI and headless runtime). */
export class DeviceLink {
	private pending?: {
		origin: string;
		pollCode: string;
		approvalCode: string;
		verificationUrl: string;
		expiresAt: number;
	};
	constructor(
		private manager: Pick<DesktopManager, "prepareLink" | "completeLink" | "status">,
		private api = (origin: string) => new LocalApi(origin),
	) {}
	async start(origin: string, name: string) {
		const status = this.manager.status();
		if (status.mode === "linked" && status.installationId && !status.error)
			return { linked: true, installationId: status.installationId, accountId: status.accountId };
		if (this.pending && this.pending.origin === origin && this.pending.expiresAt > Date.now())
			return this.view(this.pending);
		const { credentialHash } = await this.manager.prepareLink(origin);
		const result = started.parse(await this.api(origin).post("start", { name, credentialHash }));
		if (new URL(result.verificationUrl).origin !== new URL(origin).origin)
			throw new Error("Connector approval origin changed. Check the runtime origin.");
		this.pending = {
			origin,
			pollCode: result.pollCode,
			approvalCode: result.approvalCode,
			verificationUrl: result.verificationUrl,
			expiresAt: Date.now() + result.expiresIn * 1000,
		};
		return this.view(this.pending);
	}
	async poll() {
		const pending = this.pending;
		if (!pending) return { linked: this.manager.status().mode === "linked", pending: false };
		if (pending.expiresAt <= Date.now()) {
			this.pending = undefined;
			return { linked: false, pending: false, expired: true };
		}
		const result = await this.api(pending.origin).post("poll", { pollCode: pending.pollCode });
		if ((result as { status?: string }).status !== "linked")
			return { linked: false, ...this.view(pending) };
		const value = linked.parse(result);
		this.pending = undefined;
		await this.manager.completeLink({
			origin: pending.origin,
			installationId: value.installationId,
			accountId: value.accountId,
		});
		return { linked: true, installationId: value.installationId, accountId: value.accountId };
	}
	private view(pending: NonNullable<DeviceLink["pending"]>) {
		return {
			pending: true,
			approvalCode: pending.approvalCode,
			verificationUrl: pending.verificationUrl,
			expiresAt: pending.expiresAt,
			instructions:
				"Open the verification URL, sign in to Laplace, and approve this computer. Then check status.",
		};
	}
}
