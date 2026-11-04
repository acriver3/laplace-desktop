import { ToolSchema } from "@modelcontextprotocol/core";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { slackBrowserVersion, slackSetupNames } from "../shared/slack-browser";
import { SlackBrowserRelay, slackReads } from "./slack-browser-relay";

async function main() {
	const relay = new SlackBrowserRelay(process.argv[2] ?? "");
	await relay.listen();
	const server = new Server(
		{ name: "Laplace Slack Browser", version: slackBrowserVersion },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler("tools/list", async () => ({
		tools: [
			...Object.entries(slackReads).map(([name, value]) => ({
				name,
				description: `Read Slack ${name.replaceAll("_", " ")} through the user-approved existing browser tab.`,
				inputSchema: z.toJSONSchema(value.schema, { io: "input" }),
				annotations: { readOnlyHint: true, destructiveHint: false },
			})),
			...slackSetupNames.map((name) => ({
				name,
				description: "Internal Desktop catalog setup.",
				inputSchema: {
					type: "object" as const,
					properties: {},
					additionalProperties: ["laplace_browser_authorize", "laplace_browser_focus"].includes(
						name,
					),
				},
			})),
		].map((tool) => ToolSchema.parse(tool)),
	}));
	server.setRequestHandler("tools/call", async (request, ctx) => {
		try {
			const { name, arguments: args = {} } = request.params;
			let result: unknown;
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
			} else if (name === "laplace_browser_pair" || name === "laplace_browser_status") {
				z.object({}).strict().parse(args);
				result = name === "laplace_browser_pair" ? relay.pairing() : relay.status();
			} else result = await relay.read(name, args, ctx.mcpReq.signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text:
							error instanceof z.ZodError
								? "Invalid Slack read arguments."
								: error instanceof Error
									? error.message
									: "Slack read failed.",
					},
				],
			};
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
	process.stderr.write(
		"Slack browser adapter could not start. Check the workspace URL and Desktop installation.\n",
	);
	process.exitCode = 1;
});
