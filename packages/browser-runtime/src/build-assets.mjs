import { createHash } from "node:crypto";
import { mkdir, copyFile, cp, readFile, writeFile, chmod, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
/** Both clients build the same reviewed native entry with identical options. */
export async function buildBrowserAssets(
	build,
	resources,
	platform = process.platform,
	arch = process.arch,
) {
	const root = fileURLToPath(new URL("..", import.meta.url));
	await mkdir(join(resources, "helper"), { recursive: true });
	for (const [source, destination] of [
		["browser-native-entry", "browser-native-entry"],
		["yc-server", "yc-browser"],
		["slack-full-entry", "slack-full-browser"],
	]) {
		await build({
			absWorkingDir: root,
			entryPoints: [`src/${source}.ts`],
			outfile: resolve(resources, `helper/${destination}.cjs`),
			bundle: true,
			platform: "node",
			format: "cjs",
			target: "node24",
			minify: true,
		});
	}
	await cp(join(root, "extension"), join(resources, "browser-extension"), { recursive: true });
	const outlook = JSON.parse(await readFile(join(root, "assets/outlook.json"), "utf8"));
	const bytes = gunzipSync(await readFile(join(root, "assets/outlook-server.cjs.gz")));
	const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
	if (hash(bytes) !== outlook.sha256) throw Error("Outlook artifact integrity check failed.");
	await writeFile(join(resources, outlook.file), bytes);
	const yc = {
		catalogId: "ycombinator-demo",
		provider: "ycombinator",
		version: "0.1.0-demo.1",
		serverId: "ycombinator-demo",
		workspace: "https://apply.ycombinator.com",
		file: "helper/yc-browser.cjs",
		sha256: hash(await readFile(join(resources, "helper/yc-browser.cjs"))),
	};
	const { engines, ...slack } = JSON.parse(await readFile(join(root, "assets/slack.json"), "utf8"));
	const engine = engines[`${platform}-${arch}`];
	if (!engine) throw Error("Unsupported Slack browser platform.");
	const compressed = await readFile(join(root, "assets", engine.file));
	const native = gunzipSync(compressed);
	if (hash(compressed) !== engine.compressedSha256 || hash(native) !== engine.sha256)
		throw Error("Slack engine integrity check failed.");
	const executable = join(resources, `helper/slack-engine${platform === "win32" ? ".exe" : ""}`);
	await writeFile(executable, native);
	await chmod(executable, 0o755);
	slack.sha256 = hash(await readFile(join(resources, slack.file)));
	await writeFile(
		join(resources, "browser-connectors.json"),
		JSON.stringify([yc, outlook, slack], null, 2) + "\n",
	);
	await copyFile(
		join(root, "src/browser-native-host.cs"),
		join(resources, "helper/browser-native-host.cs"),
	);
	const files = {};
	const record = async (path) => {
		files[path] = hash(await readFile(join(resources, path)));
	};
	for (const file of [
		"browser-connectors.json",
		"helper/browser-native-entry.cjs",
		"helper/yc-browser.cjs",
		outlook.file,
		slack.file,
		`helper/slack-engine${platform === "win32" ? ".exe" : ""}`,
		"helper/browser-native-host.cs",
	])
		await record(file);
	for (const file of await readdir(join(resources, "browser-extension")))
		await record(`browser-extension/${file}`);
	const pin = JSON.parse(await readFile(join(root, "source-lock.json"), "utf8"));
	const extension = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
	await writeFile(
		join(resources, "browser-runtime-manifest.json"),
		JSON.stringify(
			{
				platform: `${platform}-${arch}`,
				runtimeVersion: pin.version,
				sourceRevision: pin.revision,
				nativeProtocol: 1,
				extensionVersion: extension.version,
				status: "candidate",
				files,
			},
			null,
			2,
		) + "\n",
	);
}
