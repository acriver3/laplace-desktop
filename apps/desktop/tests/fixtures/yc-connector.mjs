import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	if (
		request.method === "tools/call" &&
		request.params.name === "save_draft" &&
		process.env.SAVE_STARTED
	) {
		writeFileSync(process.env.SAVE_STARTED, "started");
		await new Promise(() => {});
	}
	const result =
		request.method === "initialize"
			? {
					protocolVersion: request.params.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "YC fixture", version: "1" },
				}
			: request.method === "tools/list"
				? {
						tools: ["list_applications", "read_application", "save_draft"].map((name) => ({
							name,
							inputSchema: { type: "object" },
						})),
					}
				: { content: [{ type: "text", text: JSON.stringify({ applications: [] }) }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
