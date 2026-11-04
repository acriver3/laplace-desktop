import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(
	({ era }) => {
		const server = new Server(
			{ name: "modern-fixture", version: "1" },
			{ capabilities: { tools: { listChanged: true } } },
		);
		server.setRequestHandler("tools/list", async () => ({
			tools: [{ name: "read", inputSchema: { type: "object" } }],
		}));
		server.setRequestHandler("tools/call", async () => ({
			content: [{ type: "text", text: era }],
		}));
		return server;
	},
	{ legacy: "reject" },
);
