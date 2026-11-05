// Minimal stand-in for helper/service.cjs: one owner per root, control shutdown, descriptor files.
import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

const root = process.argv[process.argv.indexOf("--root") + 1];
let lock;
for (let attempt = 0; !lock && attempt < 2; attempt++) {
	try {
		lock = await open(join(root, "manager.lock"), "wx");
	} catch {
		// Like the real manager lock: a dead owner's lock is reclaimed, a live one wins.
		const owner = Number(await readFile(join(root, "manager.lock"), "utf8").catch(() => "0"));
		try {
			process.kill(owner, 0);
			process.exit(0);
		} catch {
			await rm(join(root, "manager.lock"), { force: true });
		}
	}
}
await lock.writeFile(String(process.pid));
const token = randomBytes(32).toString("base64url");
const stop = async () => {
	await rm(join(root, "runtime.json"), { force: true });
	await lock.close();
	await rm(join(root, "manager.lock"), { force: true });
	process.exit(0);
};
const server = createServer((request, response) => {
	if (request.headers.authorization !== `Bearer ${token}`) return response.writeHead(401).end();
	response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result: { stopping: true } }));
	setTimeout(stop, 20);
});
server.listen(0, "127.0.0.1", async () => {
	const { port } = server.address();
	const temporary = join(root, `runtime.json.${process.pid}.tmp`);
	await writeFile(
		temporary,
		JSON.stringify({ version: 1, protocol: 1, pid: process.pid, control: `http://127.0.0.1:${port}/control/v1/`, token }),
	);
	await rename(temporary, join(root, "runtime.json"));
	await writeFile(join(root, `started-${process.pid}`), "");
});
process.on("SIGTERM", () => void stop());
