// Versioned stand-in for helper/service.cjs used by update tests.
const { randomBytes } = require("node:crypto");
const { readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync } = require("node:fs");
const { createServer } = require("node:http");
const { join } = require("node:path");

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = arg("--root"),
	resources = arg("--resources");
const version = readFileSync(join(resources, "VERSION"), "utf8").trim();
const [behavior, slowMs = "1500"] = readFileSync(join(resources, "BEHAVIOR"), "utf8")
	.trim()
	.split(":");
if (behavior === "crash") process.exit(1);
// "stubborn" ignores shutdown and SIGTERM; "busy" never grants the maintenance lease;
// "slow" holds the profile lock but publishes its descriptor late, like a cold first start.
let leased = false;
let lock;
try {
	lock = openSync(join(root, "manager.lock"), "wx");
} catch {
	process.exit(0);
}
writeFileSync(lock, String(process.pid));
writeFileSync(join(root, `cwd-${process.pid}.txt`), process.cwd());
const token = randomBytes(32).toString("base64url");
const stop = () => {
	rmSync(join(root, "runtime.json"), { force: true });
	closeSync(lock);
	rmSync(join(root, "manager.lock"), { force: true });
	process.exit(0);
};
const server = createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => (body += chunk));
	request.on("end", () => {
		if (request.headers.authorization !== `Bearer ${token}`)
			return response.writeHead(401).end();
		const { method } = JSON.parse(body || "{}");
		const reply = (result) =>
			response
				.writeHead(200, { "Content-Type": "application/json" })
				.end(JSON.stringify({ result }));
		if (method === "runtime.info") return reply({ version });
		if (method === "updates.acquire") {
			if (behavior === "busy" || leased) return reply(false);
			leased = true;
			return reply(true);
		}
		if (method === "updates.release") {
			leased = false;
			return reply(true);
		}
		if (method === "status") return reply({ mode: "local-only" });
		if (method === "shutdown") {
			reply({ stopping: true });
			if (behavior !== "stubborn") setTimeout(stop, 20);
			return;
		}
		response.writeHead(200).end(JSON.stringify({ error: "unsupported" }));
	});
});
server.listen(0, "127.0.0.1", () => {
	const { port } = server.address();
	const temporary = join(root, `runtime.json.${process.pid}.tmp`);
	writeFileSync(
		temporary,
		JSON.stringify({
			version: 1,
			protocol: 1,
			pid: process.pid,
			control: `http://127.0.0.1:${port}/control/v1/`,
			token,
		}),
	);
	setTimeout(
		() => renameSync(temporary, join(root, "runtime.json")),
		behavior === "slow" ? Number(slowMs) : 0,
	);
});
process.on("SIGTERM", () => {
	if (behavior !== "stubborn") stop();
});
