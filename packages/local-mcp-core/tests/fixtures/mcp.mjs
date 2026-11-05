import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const child =
	process.env.SPAWN_CHILD === "true"
		? spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
		: undefined;
const tools = [
	{
		name: "read",
		description: "Read synthetic data",
		annotations: { readOnlyHint: true, idempotentHint: true },
		_meta: { fixtureTag: "local-only" },
		outputSchema: {
			type: "object",
			properties: { input: { type: "object" }, credentialPresent: { type: "boolean" } },
			required: ["input", "credentialPresent"],
		},
		inputSchema: {
			type: "object",
			properties: { delay: { type: "number" } },
			additionalProperties: false,
		},
	},
	{
		name: "write",
		description: "Write synthetic data",
		inputSchema: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		},
	},
];
process.stderr.write(`Synthetic diagnostic ${process.env.TEST_CREDENTIAL ?? ""}\n`);
for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (message.id === undefined) continue;
	let result;
	if (message.method === "initialize")
		result = {
			protocolVersion: message.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "fixture", version: "1" },
		};
	else if (message.method === "tools/list") {
		result =
			process.env.PAGINATE === "true"
				? message.params?.cursor
					? { tools: [tools[1]] }
					: { tools: [tools[0]], nextCursor: "page2" }
				: { tools };
		if (process.env.CRASH_AFTER_DISCOVERY === "true") setTimeout(() => process.exit(1), 100);
	} else if (message.method === "tools/call") {
		if (message.params.name === "write" && process.env.WRITE_EFFECT_FILE)
			appendFileSync(process.env.WRITE_EFFECT_FILE, "write\n");
		if (message.params.name === "write" && process.env.EXIT_ON_WRITE === "true") process.exit(1);
		await new Promise((resolve) => setTimeout(resolve, message.params.arguments?.delay ?? 0));
		result = {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						input: message.params.arguments,
						credentialPresent: Boolean(process.env.TEST_CREDENTIAL),
						credential: process.env.TEST_CREDENTIAL,
						operatorToken: process.env.OPEN_CONNECTOR_ADMIN_TOKEN,
						argv: process.argv.slice(2),
						childPid: child?.pid,
					}),
				},
			],
		};
		result.structuredContent = JSON.parse(result.content[0].text);
	} else result = {};
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
}
