import { createInterface } from "node:readline";

import { minimalEnvironment } from "../../src/config";
import { spawnLocal } from "../../src/process";
const [root, resources, fixture] = process.argv.slice(2);
const child = spawnLocal(
	process.execPath,
	[fixture],
	root,
	minimalEnvironment(root, { SPAWN_CHILD: "true" }),
	resources,
);
child.stderr.resume();
child.on("error", () => process.exit(1));
child.stdin.write(
	JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "guardian-test", version: "1" },
		},
	}) + "\n",
);
createInterface({ input: child.stdout }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === 1)
		child.stdin.write(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "read", arguments: {} },
			}) + "\n",
		);
	else if (message.id === 2)
		process.stdout.write(
			JSON.stringify({
				managed: child.pid,
				descendant: JSON.parse(message.result.content[0].text).childPid,
			}) + "\n",
		);
});
