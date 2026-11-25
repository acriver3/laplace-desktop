import { Server } from "@modelcontextprotocol/server";
import { readPreload, withPreload, type PreloadResult } from "@repo/project-protocol/mcp/preload";

// Preserve SDK negotiation for both the legacy initialize and modern discovery handlers.
export class DiscoveryServer extends Server {
	preload?: (raw: unknown, signal: AbortSignal) => Promise<PreloadResult | undefined>;
	protected override _wrapHandler(
		method: string,
		handler: Parameters<Server["_wrapHandler"]>[1],
	): ReturnType<Server["_wrapHandler"]> {
		const original = super._wrapHandler(method, handler);
		if (method !== "initialize" && method !== "server/discover") return original;
		return async (request, ctx) => {
			const base = await original(request, ctx);
			const hint = readPreload(request.params);
			if (hint === undefined || !this.preload) return base;
			const result = await this.preload(hint, ctx.mcpReq.signal);
			return withPreload(base, result);
		};
	}
}
