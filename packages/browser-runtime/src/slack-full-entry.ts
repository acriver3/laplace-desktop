import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import artifact from "../assets/slack.json";
import { runSlackBrowser } from "./slack-full-server";
async function main() {
	const platform = `${process.platform}-${process.arch}` as keyof typeof artifact.engines;
	const engine = artifact.engines[platform];
	if (!engine) throw Error("Unsupported Slack browser platform.");
	const binary = join(__dirname, `slack-engine${process.platform === "win32" ? ".exe" : ""}`);
	if (
		createHash("sha256")
			.update(await readFile(binary))
			.digest("hex") !== engine.sha256
	)
		throw Error("Slack engine integrity check failed.");
	await runSlackBrowser(binary);
}
void main().catch(() => {
	process.stderr.write("Slack browser connector could not start.\n");
	process.exitCode = 1;
});
