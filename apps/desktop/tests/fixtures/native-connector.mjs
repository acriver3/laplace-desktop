import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Synthetic subprocess used only by native integration tests. It accesses no service.
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result;
	if (request.method === "initialize")
		result = {
			protocolVersion: request.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "desktop-native-fixture", version: "1" },
		};
	else if (request.method === "tools/list")
		result = {
			tools: [
				{
					name: "read",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		};
	else if (request.method === "tools/call")
		result = {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						pid: process.pid,
						childPid: child.pid,
						credentialPresent: process.env.SYNTHETIC_SECRET === "desktop-native-only",
					}),
				},
			],
		};
	else result = {};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
