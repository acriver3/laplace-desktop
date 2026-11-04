import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const names = ["read", "write", "canvas_whoami", "canvas_list_courses"];
const releaseFile = process.argv[2] === "--release-file" ? process.argv[3] : undefined;
process.stderr.write(`fixture diagnostic ${process.env.TEST_SECRET ?? ""}\n`);
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result;
	if (request.method === "initialize")
		result = {
			protocolVersion: request.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "desktop-fixture", version: "1.0.0" },
		};
	else if (request.method === "tools/list")
		result = {
			tools: names.map((name) => ({
				name,
				inputSchema: {
					type: "object",
					properties: { delay: { type: "number" } },
					additionalProperties: false,
				},
			})),
		};
	else if (request.method === "tools/call") {
		if (process.env.EFFECT_FILE)
			appendFileSync(process.env.EFFECT_FILE, request.params.name + "\n");
		while (releaseFile && !existsSync(releaseFile)) await new Promise((r) => setTimeout(r, 5));
		if (request.params.arguments?.delay)
			await new Promise((r) => setTimeout(r, request.params.arguments.delay));
		result = {
			content: [
				{ type: "text", text: JSON.stringify({ pid: process.pid, name: request.params.name }) },
			],
		};
	} else result = {};
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
