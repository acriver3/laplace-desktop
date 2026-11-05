import { ToolSchema } from "@modelcontextprotocol/core";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { ycBrowserVersion, ycSetupNames } from "./yc-browser";
import { ycActions, YcBrowserRelay } from "./yc-browser-relay";

async function main() {
	const relay = new YcBrowserRelay();
	await relay.listen();
	const server = new Server(
		{ name: "Y Combinator — Demo Only", version: ycBrowserVersion },
		{ capabilities: { tools: {} } },
	);
	const descriptions: Record<string, string> = {
		list_applications:
			"List applications visible in the approved YC tab. Open the YC home page to see all applications.",
		read_application:
			"Read the application currently open in the approved YC tab, with field names and a revision for safe editing.",
		save_draft:
			"Preview draft answer changes by default. Pass confirm:true with the latest expectedRevision to click Save changes once and verify persisted answers. Never submits an application. On an uncertain result, read again before any retry.",
	};
	server.setRequestHandler("tools/list", async () => ({
		tools: [
			...Object.entries(ycActions).map(([name, value]) => ({
				name,
				description: descriptions[name],
				inputSchema: z.toJSONSchema(value.schema, { io: "input" }),
				annotations: {
					readOnlyHint: name !== "save_draft",
					destructiveHint: name === "save_draft",
					idempotentHint: name !== "save_draft",
				},
			})),
			...ycSetupNames.map((name) => ({
				name,
				description: "Internal Laplace browser approval setup.",
				inputSchema: {
					type: "object" as const,
					properties: {},
					additionalProperties: ["laplace_browser_authorize", "laplace_browser_focus"].includes(
						name,
					),
				},
			})),
			{
				name: "connect_browser",
				description:
					"Start YC sign-in approval through the Laplace browser extension, using the same existing-tab flow as Slack. Sign in to YC normally, open the extension on that tab, review and approve the pending request. Does not collect credentials.",
				inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
			},
		].map((tool) => ToolSchema.parse(tool)),
	}));
	let busy = false;
	server.setRequestHandler("tools/call", async (request, ctx) => {
		if (busy)
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: "YC is busy. Wait for the current operation; do not replay a save.",
					},
				],
			};
		busy = true;
		try {
			const { name, arguments: args = {} } = request.params;
			let result: any;
			if (
				[
					"laplace_browser_review",
					"laplace_browser_authorize",
					"laplace_browser_focus",
					"laplace_browser_revoke",
				].includes(name)
			) {
				result =
					name === "laplace_browser_review"
						? relay.review()
						: name === "laplace_browser_authorize"
							? relay.authorize(args)
							: name === "laplace_browser_focus"
								? relay.focus(args)
								: relay.revoke();
			} else if (name === "connect_browser") {
				z.object({}).strict().parse(args);
				result = {
					instructions:
						"Use Laplace browser authentication for this connection, then review and approve the account in its approval card or local approval page.",
				};
			} else if (ycSetupNames.includes(name)) {
				z.object({}).strict().parse(args);
				result = name === "laplace_browser_pair" ? relay.pairing() : relay.status();
			} else result = await relay.read(name, args, ctx.mcpReq.signal);
			return {
				...(result?.error ? { isError: true } : {}),
				content: [{ type: "text", text: JSON.stringify(result) }],
			};
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text:
							error instanceof z.ZodError
								? "Invalid YC arguments."
								: error instanceof Error
									? error.message
									: "YC operation failed.",
					},
				],
			};
		} finally {
			busy = false;
		}
	});
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		await relay.close();
		await server.close();
	};
	process.stdin.once("end", () => void close());
	process.once("SIGTERM", () => void close());
	process.once("SIGINT", () => void close());
	await server.connect(new StdioServerTransport());
}
void main().catch(() => {
	process.stderr.write("YC demo connector could not start.\n");
	process.exitCode = 1;
});
