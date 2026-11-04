// Real packaged N -> N+1 update against a private local Git fixture. Never changes
// the user's installation, Git configuration, profile, or published release tags.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo, homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "laplace-source-native-"));
const originalPath = process.env.PATH;
const originalHome = process.env.HOME,
	originalUserProfile = process.env.USERPROFILE,
	originalLocal = process.env.LOCALAPPDATA;
const git = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], {
	encoding: "utf8",
})
	.trim()
	.split(/\r?\n/)[0];
const source = join(scratch, "repository"),
	home = join(scratch, "home");
const children = [];
let success = false,
	cleanupProfile;
try {
	await mkdir(source);
	await mkdir(home);
	console.log("Copying source into an isolated release fixture…");
	const files = execFileSync(git, ["ls-files", "-c", "-o", "--exclude-standard", "-z"], {
		cwd: repositoryRoot,
		maxBuffer: 10 * 1024 ** 2,
	})
		.toString()
		.split("\0")
		.filter(Boolean);
	for (const file of new Set(files)) {
		await mkdir(dirname(join(source, file)), { recursive: true });
		await cp(join(repositoryRoot, file), join(source, file));
	}
	const bundled = join(scratch, "test-api.cjs");
	await build({
		stdin: {
			contents:
				'export * from "./apps/desktop/src/update/common"; export * from "./apps/desktop/src/update/source"; export * from "./apps/desktop/src/update/installer";',
			resolveDir: repositoryRoot,
		},
		outfile: bundled,
		bundle: true,
		platform: "node",
		format: "cjs",
	});
	const api = (await import(pathToFileURL(bundled).href)).default;
	const pnpm = await api.resolvePnpm();
	const store = execFileSync(process.execPath, [pnpm, "store", "path"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim();
	process.env.HOME = home;
	if (process.platform === "win32") process.env.USERPROFILE = home;
	process.env.LOCALAPPDATA = join(home, "AppData", "Local");
	assert.equal(homedir(), home, "Native update checks must use the isolated home directory");
	await writeFile(join(home, ".npmrc"), `store-dir=${store}\n`);
	await writeFile(
		join(home, ".gitconfig"),
		`[user]\n name = Native update fixture\n email = update-test@localhost\n[url "${source.replaceAll("\\", "/")}"]\n insteadOf = ${api.repository}\n`,
	);
	const gitRun = (...args) =>
		execFileSync(git, args, {
			cwd: source,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	gitRun("init", "-q");
	gitRun("add", ".");
	gitRun("-c", "commit.gpgsign=false", "commit", "-qm", "Version N fixture");
	const before = gitRun("rev-parse", "HEAD");
	const packageFile = join(source, "apps/desktop/package.json"),
		pkg = JSON.parse(await readFile(packageFile, "utf8"));
	const baselineVersion = pkg.version;
	const parts = baselineVersion.split(".").map(Number);
	pkg.version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
	await writeFile(packageFile, JSON.stringify(pkg, null, "\t") + "\n");
	gitRun("add", ".");
	gitRun("-c", "commit.gpgsign=false", "commit", "-qm", "Version N+1 fixture");
	const after = gitRun("rev-parse", "HEAD");
	gitRun("tag", `desktop-v${pkg.version}`);
	const root = api.updateRoot(),
		target = api.nativeTarget(),
		destination = api.defaultDestination();
	await mkdir(root, { recursive: true });
	await mkdir(dirname(destination), { recursive: true });
	const originalPackage = join(
		repositoryRoot,
		"apps/desktop/out",
		`Laplace-${target}`,
		...(target.startsWith("darwin-") ? ["Laplace.app"] : []),
	);
	await cp(originalPackage, destination, { recursive: true, verbatimSymlinks: true });
	const installation = {
		protocol: 1,
		id: randomUUID(),
		owner: userInfo().username,
		repository: api.repository,
		target,
		path: destination,
		version: baselineVersion,
		commit: before,
		git,
		node: process.execPath,
		pnpm,
		toolPath: process.env.PATH,
	};
	await api.writeJson(join(root, "installation.json"), installation);
	if (process.platform !== "win32") process.env.PATH = "/usr/bin:/bin";
	// Keep the native login keychain available to the app while Git and installer
	// metadata remain in the fixture home. Profile keys stay fixture-scoped.
	const keychainHome = process.platform === "darwin" ? originalHome : undefined;
	const probeOptions = { stderr: process.stderr, home: keychainHome };
	await api.probePackage(destination, target, baselineVersion, root, undefined, probeOptions);
	console.log("Version N starts. Downloading and building N+1 through the source updater…");
	const tags = await api.run(
		git,
		["ls-remote", "--tags", "--", api.repository, "refs/tags/desktop-v*"],
		{ authentication: true },
	);
	const release = api.selectRelease(tags, baselineVersion);
	assert.equal(release.commit, after);
	await api.prepareSource(
		installation,
		release,
		root,
		(phase) => console.log(`Update: ${phase}`),
		undefined,
		probeOptions,
	);
	const isolatedProfile = join(scratch, "user-profile");
	cleanupProfile = () => api.cleanupProbeCredentials(originalPackage, target, isolatedProfile, keychainHome);
	await mkdir(isolatedProfile);
	await writeFile(join(isolatedProfile, "preserved.txt"), "User settings remain unchanged");
	const host = {
		...api.nativeInstallerHost,
		async launch(path, platform, nonce) {
			const child = spawn(
				api.executable(path, platform),
				nonce ? [`--laplace-update-accept=${nonce}`] : [],
				{
				env: {
					...api.toolEnvironment(),
					...(keychainHome ? { HOME: keychainHome } : {}),
					LAPLACE_DESKTOP_TEST_ROOT: isolatedProfile,
					LAPLACE_DESKTOP_TEST_UPDATE_ROOT: root,
				},
					stdio: "ignore",
				},
			);
			children.push(child);
			await new Promise((done, fail) => {
				child.once("spawn", done);
				child.once("error", fail);
			});
			return {
				async stop() {
					child.kill();
					await delay(1500);
				},
			};
		},
	};
	await api.installPrepared(root, installation, host);
	assert.equal((await api.readJson(join(root, "installation.json"))).version, pkg.version);
	assert.equal(
		await readFile(join(isolatedProfile, "preserved.txt"), "utf8"),
		"User settings remain unchanged",
	);
	for (const child of children) child.kill();
	await delay(2000);
	const current = await api.readJson(join(root, "installation.json"));
	const recoveryId = randomUUID(),
		recoveryPackage = api.stagedPackage(root, recoveryId);
	await cp(destination, recoveryPackage, { recursive: true, verbatimSymlinks: true });
	await writeFile(join(recoveryPackage, "recovery-test-marker"), "candidate only");
	await api.writeJson(join(root, "pending.json"), {
		id: recoveryId,
		installationId: current.id,
		version: current.version,
		commit: current.commit,
		digest: await api.packageDigest(recoveryPackage),
	});
	console.log("Exercising native replacement rollback after a failed startup check…");
	await assert.rejects(
		api.installPrepared(root, current, {
			...host,
			async waitForHealth() {
				throw new Error("Injected native startup-check failure");
			},
		}),
		/Injected native/,
	);
	assert.equal(await api.exists(join(destination, "recovery-test-marker")), false);
	assert.equal((await api.readJson(join(root, "installation.json"))).commit, current.commit);
	assert.equal(
		await readFile(join(isolatedProfile, "preserved.txt"), "utf8"),
		"User settings remain unchanged",
	);
	console.log(
		`PASS: packaged ${target} ${baselineVersion} → ${pkg.version}; startup receipt, native rollback and profile preservation verified.`,
	);
	success = true;
} finally {
	for (const child of children) child.kill();
	await delay(2000);
	await cleanupProfile?.();
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalLocal === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = originalLocal;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	if (success) await rm(scratch, { recursive: true, force: true });
	else console.error(`Native update fixture retained for diagnosis: ${scratch}`);
}
