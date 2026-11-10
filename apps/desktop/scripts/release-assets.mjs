import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import yauzl from "yauzl";

const root = fileURLToPath(new URL("..", import.meta.url));
const targets = new Set(["darwin-arm64", "darwin-x64", "win32-x64"]);

export function validateReleaseManifest(input, version) {
	assert.equal(
		input?.version,
		version,
		"Validation manifest must match the desktop package version",
	);
	assert.match(
		input.sourceRevision ?? "",
		/^[a-f0-9]{40}$/,
		"Record the validated source revision",
	);
	assert.equal(
		typeof input.workingTreeChanges,
		"boolean",
		"Record whether the validated build includes uncommitted source changes",
	);
	assert.ok(
		Array.isArray(input.artifacts) && input.artifacts.length > 0,
		"Select at least one validated archive",
	);
	const seen = new Set();
	for (const item of input.artifacts) {
		assert.ok(
			targets.has(item.platform) && !seen.has(item.platform),
			"Select one archive per supported platform",
		);
		seen.add(item.platform);
		assert.equal(typeof item.file, "string");
		assert.equal(
			basename(item.file),
			`Laplace-${item.platform}-${version}.zip`,
			"Archive filename must identify its platform and version",
		);
		assert.match(item.sha256 ?? "", /^[a-f0-9]{64}$/, "Record the exact validated archive SHA-256");
		assert.equal(
			item.validation?.packagedElectron,
			"passed",
			"Packaged Electron smoke must pass before release preparation",
		);
		assert.equal(
			item.validation?.nativeRuntime,
			"passed",
			"Packaged native runtime smoke must pass before release preparation",
		);
		assert.ok(
			["native", "rosetta"].includes(item.validation?.execution),
			"Record native or Rosetta validation",
		);
		assert.ok(
			item.validation.execution !== "rosetta" || item.platform === "darwin-x64",
			"Rosetta validation applies only to Intel Mac archives",
		);
		assert.ok(
			typeof item.validation.notes === "string" && item.validation.notes.length <= 2000,
			"Record validation scope and limitations",
		);
	}
	return input;
}

export function requiredArchiveEntries(platform) {
	assert.ok(targets.has(platform), "Unsupported archive platform");
	const mac = platform.startsWith("darwin-");
	const resources = mac ? "Laplace.app/Contents/Resources" : "resources";
	const runtime = `${resources}/runtime`;
	const native = `${platform}${mac ? "" : "-msvc"}`;
	return [
		mac ? "Laplace.app/Contents/MacOS/Laplace" : "Laplace.exe",
		`${resources}/app.asar`,
		`${runtime}/helper/service.cjs`,
		`${runtime}/helper/launcher.cjs`,
		`${runtime}/helper/bridge.cjs`,
		`${runtime}/runtimes/node${mac ? "" : ".exe"}`,
		`${runtime}/runtimes/uv${mac ? "" : ".exe"}`,
		`${runtime}/runtimes/npm/bin/npm-cli.js`,
		`${runtime}/runtimes/npm/bin/npx-cli.js`,
		`${runtime}/node_modules/@napi-rs/keyring/index.js`,
		`${runtime}/node_modules/@napi-rs/keyring-${native}/keyring.${native}.node`,
		...(mac ? [] : [`${runtime}/runtimes/process-host.exe`]),
	];
}

export async function inspectArchive(file, platform) {
	const zip = await new Promise((accept, reject) =>
		yauzl.open(file, { lazyEntries: true, strictFileNames: true }, (error, value) =>
			error ? reject(error) : accept(value),
		),
	);
	const required = new Set(requiredArchiveEntries(platform));
	await new Promise((accept, reject) => {
		zip.on("error", reject);
		zip.on("entry", (entry) => {
			const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
			if ((kind === 0 || kind === 0o100000) && entry.uncompressedSize > 0)
				required.delete(entry.fileName);
			zip.readEntry();
		});
		zip.on("end", accept);
		zip.readEntry();
	}).finally(() => zip.close());
	assert.equal(
		required.size,
		0,
		`Archive is missing standalone application assets: ${[...required].join(", ")}`,
	);
}

export async function sha256(file) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

export function installationReadme(manifest, repository) {
	if (repository)
		assert.match(
			repository,
			/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
			"Use a GitHub owner/repository name",
		);
	const releases = repository
		? `https://github.com/${repository}/releases`
		: "the GitHub Releases page supplied by Laplace";
	const archives = manifest.artifacts
		.map(
			(item) =>
				`- ${item.name}: ${item.platform}${item.validation.execution === "rosetta" ? " (tested under Rosetta on Apple Silicon; physical Intel Mac acceptance remains pending)" : ""}`,
		)
		.join("\n");
	return `# Install Laplace Desktop ${manifest.version}\n\nDownload the matching archive and SHA256SUMS from ${releases}. Use the assets attached to your chosen release, rather than GitHub's source-code archives. This test build is unsigned; macOS builds are not notarized. No automatic updates are included.\n\n## Included downloads\n\n${archives}\n\n## macOS\n\n1. Choose darwin-arm64 for Apple Silicon or darwin-x64 for an Intel Mac. Verify the archive's SHA-256 against SHA256SUMS (for example, run \`shasum -a 256 <archive.zip>\`).\n2. Extract the ZIP, then move **Laplace.app** into **/Applications** before opening it or registering an AI client. Do not configure clients while the app is in Downloads or a temporary location; macOS App Translocation can change the executable path.\n3. Open Laplace from Applications. If macOS blocks this unsigned test build, only allow it through System Settings > Privacy & Security after you trust the release and have checked its checksum.\n4. Install catalog connectors and custom/manual/imported local tools without Laplace sign-in. Sign in for hosted Laplace tools and account features. A connector's provider login is separate and may still be required.\n5. Open **On this device → AI clients**, choose your AI assistant, then send or copy its setup instructions. Use **Advanced: manual setup** to preview and install configuration yourself. If you later move or replace the app, review and reinstall those client entries.\n\nSigned in, the window shows Laplace exactly as in a browser, including its sidebar and Settings. **On this device** (in Laplace's sidebar, or the only page while signed out) holds this computer's connections and catalog, **AI clients**, **Info** (runtime details), **Tools** (Laplace Point), **Settings** (environment and explicit installation linking), **Updates**, and **Credentials**. **Connect Laplace tools** in a local AI client registration grants that client hosted access through a separate OAuth flow; desktop sign-in alone does not grant client access.\n\nDeploy the compatible backend before distributing this Desktop build. The server must advertise web shell version 1 to open Laplace in Desktop; older servers show an update-required state while On this device remains usable. Hosted content and OAuth popups receive no Desktop preload or privileged IPC. **File > Laplace** (Cmd/Ctrl+1) and **File > On this device** (Cmd/Ctrl+2) switch views; the tray/menu-bar item opens On this device.\n\nThe application includes Electron, Node/npm, uv, the local helper, bridge, and native keychain binding. It needs no repository checkout, separate Node installation, or pnpm. Connectors can have their own browser and dependency requirements. Closing the window leaves Laplace running in the menu bar; Quit stops its managed processes.\n\n## Windows\n\n${manifest.artifacts.some((item) => item.platform === "win32-x64") ? "This set contains a Windows ZIP. Extract the complete folder to a stable location, run Laplace.exe, and configure AI clients afterward. A separately validated Windows installer is not included by this archive-preparation command." : "The Windows installer and native validation are pending. This release set contains no validated Windows download."}\n\n## Validation and updates\n\nRELEASE-MANIFEST.json records the exact archive hashes, source revision, and declared smoke-test scope. SHA256SUMS checks file integrity; it is not a code signature. Cloudflare runs source validation; macOS and Windows native acceptance requires those platforms. Download future updates from the same release source and quit Laplace before replacing it. Hosted sign-in requires a backend version that supports desktop handoff.\n`;
}

export async function prepareReleaseAssets(
	input,
	{ version, baseDirectory, destination, repository } = {},
) {
	validateReleaseManifest(input, version);
	if (repository)
		assert.match(
			repository,
			/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
			"Use a GitHub owner/repository name",
		);
	const selected = [];
	for (const item of input.artifacts) {
		const file = resolve(baseDirectory, item.file);
		const info = await lstat(file);
		assert.ok(info.isFile() && !info.isSymbolicLink(), "Select a regular archive file");
		assert.equal(await sha256(file), item.sha256, "Archive changed since its recorded validation");
		await inspectArchive(file, item.platform);
		selected.push({
			file,
			name: basename(file),
			platform: item.platform,
			sha256: item.sha256,
			size: info.size,
			validation: {
				packagedElectron: "passed",
				nativeRuntime: "passed",
				execution: item.validation.execution,
				notes: item.validation.notes,
			},
		});
	}
	const manifest = {
		version,
		sourceRevision: input.sourceRevision,
		workingTreeChanges: input.workingTreeChanges,
		signed: false,
		notarized: false,
		automaticUpdates: false,
		artifacts: selected.map(({ file: _file, ...item }) => item),
	};
	await mkdir(dirname(destination), { recursive: true });
	await mkdir(destination); // Never replace a previous prepared release.
	try {
		for (const item of selected) {
			await copyFile(item.file, join(destination, item.name));
			assert.equal(
				await sha256(join(destination, item.name)),
				item.sha256,
				"Archive changed while copying",
			);
		}
		await writeFile(
			join(destination, "RELEASE-MANIFEST.json"),
			JSON.stringify(manifest, null, 2) + "\n",
			{ flag: "wx" },
		);
		await writeFile(join(destination, "INSTALL.md"), installationReadme(manifest, repository), {
			flag: "wx",
		});
		const names = [
			...selected.map((item) => item.name),
			"INSTALL.md",
			"RELEASE-MANIFEST.json",
		].sort();
		const checksums = await Promise.all(
			names.map(async (name) => `${await sha256(join(destination, name))}  ${name}`),
		);
		await writeFile(join(destination, "SHA256SUMS"), checksums.join("\n") + "\n", { flag: "wx" });
		return { destination, files: [...names, "SHA256SUMS"], published: false };
	} catch (error) {
		await rm(destination, { recursive: true, force: true });
		throw error;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2),
		options = {};
	for (let i = 0; i < args.length; i += 2) {
		assert.ok(
			["--manifest", "--out", "--repo"].includes(args[i]) &&
				args[i + 1] &&
				!args[i + 1].startsWith("--"),
			"Usage: release:prepare --manifest <validated.json> [--out <new-directory>] [--repo <owner/repository>]",
		);
		assert.ok(options[args[i]] === undefined, "Duplicate release option");
		options[args[i]] = args[i + 1];
	}
	assert.ok(
		options["--manifest"],
		"Provide an explicit validation manifest; no artifact is assumed validated",
	);
	const file = resolve(options["--manifest"]);
	const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const result = await prepareReleaseAssets(JSON.parse(await readFile(file, "utf8")), {
		version,
		baseDirectory: dirname(file),
		destination: resolve(options["--out"] ?? join(root, "out/release", version)),
		repository: options["--repo"],
	});
	console.log(JSON.stringify(result, null, 2));
}
