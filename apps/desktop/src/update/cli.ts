import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

import { cp, mkdir, realpath } from "./filesystem";

import { z } from "zod";

import {
	assertDestination,
	defaultDestination,
	exists,
	installationSchema,
	lock,
	nativeTarget,
	newer,
	packageDigest,
	readJson,
	repository,
	requireAppClosed,
	requireSpace,
	resolvePnpm,
	resolveTool,
	revisionSchema,
	run,
	selectRelease,
	updateRoot,
	validateTools,
	versionSchema,
	writeJson,
	type Installation,
} from "./common";
import {
	applyFromHandoff,
	installPrepared,
	nativeInstallerHost,
	recoverInstallation,
	stagedPackage,
} from "./installer";
import { probePackage } from "./source";

const nativeReleaseEvidenceSchema = z
	.object({
		commit: revisionSchema,
		version: versionSchema,
		localValidation: z.literal("passed"),
		platforms: z
			.object({
				"darwin-arm64": z
					.object({
						packaged: z.literal("passed"),
						update: z.literal("passed"),
						recovery: z.literal("passed"),
						execution: z.literal("native"),
					})
					.strict(),
				"darwin-x64": z
					.object({
						packaged: z.literal("passed"),
						update: z.literal("passed"),
						recovery: z.literal("passed"),
						execution: z.literal("native"),
					})
					.strict(),
				"win32-x64": z
					.object({
						packaged: z.literal("passed"),
						update: z.literal("passed"),
						recovery: z.literal("passed"),
						execution: z.literal("native"),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();

export const releaseEvidenceSchema = z.union([
	nativeReleaseEvidenceSchema,
	z
		.object({
			commit: revisionSchema,
			version: versionSchema,
			localValidation: z.literal("passed"),
			userAcceptance: z
				.object({
					statement: z.string().trim().min(1),
					acceptedAt: z.iso.datetime(),
					nativeResults: z.literal("not-attested"),
				})
				.strict(),
		})
		.strict(),
]);

export function releaseAnnotation(evidence: z.infer<typeof releaseEvidenceSchema>) {
	const acceptance =
		"userAcceptance" in evidence
			? `user accepted publication at ${evidence.userAcceptance.acceptedAt}; native test results not attested. Acceptance: ${evidence.userAcceptance.statement}`
			: "native validation passed on macOS arm64/x64 and Windows x64.";
	return `Laplace Desktop ${evidence.version}; source update protocol 1; ${acceptance}`;
}

async function checkoutIdentity(root: string, git: string) {
	const options = { cwd: root, authentication: true };
	if ((await run(git, ["remote", "get-url", "origin"], options)) !== repository)
		throw new Error("Source setup requires the canonical Laplace HTTPS origin.");
	if (await run(git, ["status", "--porcelain", "--untracked-files=normal"], options))
		throw new Error(
			"Commit or set aside local changes before source setup; your clone will not be modified.",
		);
	return revisionSchema.parse(await run(git, ["rev-parse", "HEAD"], options));
}

export async function bootstrap(checkout: string, adoption?: string) {
	const root = updateRoot();
	await mkdir(root, { recursive: true, mode: 0o700 });
	const unlock = await lock(root);
	try {
		if (await exists(join(root, "journal.json")))
			throw new Error("Run source:install --recover before installing again.");
		const tools = {
			git: await resolveTool("git"),
			node: await realpath(process.execPath),
			pnpm: await resolvePnpm(),
			toolPath: process.env.PATH ?? process.env.Path ?? "",
		};
		await validateTools(tools);
		await requireSpace(root);
		const commit = await checkoutIdentity(checkout, tools.git);
		const pkg = (await readJson(join(checkout, "apps/desktop/package.json"))) as {
			version: string;
			sourceUpdateProtocol?: number;
		};
		versionSchema.parse(pkg.version);
		if (pkg.sourceUpdateProtocol !== 1)
			throw new Error("This checkout does not support source updates.");
		const existing = (await exists(join(root, "installation.json")))
			? installationSchema.parse(await readJson(join(root, "installation.json")))
			: undefined;
		const destination = adoption ? resolve(adoption) : (existing?.path ?? defaultDestination());
		assertDestination(destination);
		if (
			!existing &&
			!adoption &&
			process.platform === "darwin" &&
			(await exists("/Applications/Laplace.app"))
		)
			throw new Error(
				"An existing Laplace app was found. Quit it and use --adopt /Applications/Laplace.app to preserve assistant paths.",
			);
		await requireAppClosed(destination, nativeTarget());
		if (existing && (existing.owner !== userInfo().username || existing.path !== destination))
			throw new Error("Existing source installation does not match this setup.");
		if (!existing && (await exists(destination)) && !adoption)
			throw new Error(
				"An app already exists. Quit it, then pass --adopt with its exact path to replace it while preserving user data.",
			);
		if (adoption && !(await exists(destination)))
			throw new Error("The application selected for adoption does not exist.");
		const installation: Installation = {
			protocol: 1,
			id: existing?.id ?? randomUUID(),
			owner: userInfo().username,
			repository,
			target: nativeTarget(),
			path: destination,
			version: existing?.version ?? pkg.version,
			commit: existing?.commit ?? commit,
			...tools,
		};
		console.log("Building Laplace Desktop. Keep your existing app closed until setup completes.");
		await run(tools.node, [tools.pnpm, "install", "--frozen-lockfile"], {
			cwd: checkout,
			timeout: 1_800_000,
		});
		await run(tools.node, [tools.pnpm, "--filter", "@repo/desktop", "package"], {
			cwd: checkout,
			timeout: 1_800_000,
		});
		const output = join(
			checkout,
			"apps/desktop/out",
			`Laplace-${installation.target}`,
			...(installation.target.startsWith("darwin-") ? ["Laplace.app"] : []),
		);
		await probePackage(output, installation.target, pkg.version, root);
		await mkdir(dirname(destination), { recursive: true });
		if (await exists(destination)) {
			const id = randomUUID(),
				staged = stagedPackage(root, id);
			await cp(output, staged, { recursive: true, verbatimSymlinks: true });
			await writeJson(join(root, "installation.json"), installation);
			await writeJson(join(root, "pending.json"), {
				id,
				installationId: installation.id,
				version: pkg.version,
				commit,
				digest: await packageDigest(staged),
			});
			await installPrepared(root, installation);
		} else {
			await cp(output, destination, {
				recursive: true,
				verbatimSymlinks: true,
				errorOnExist: true,
				force: false,
			});
			await writeJson(join(root, "installation.json"), {
				...installation,
				version: pkg.version,
				commit,
			});
			await nativeInstallerHost.launch(destination, installation.target);
		}
		console.log(
			`Installed Laplace ${pkg.version}. Future updates are available in Settings → Device.`,
		);
	} finally {
		await unlock();
	}
}

export async function publishSourceRelease(checkout: string, evidenceFile: string) {
	const git = await resolveTool("git"),
		commit = await checkoutIdentity(checkout, git);
	const evidence = releaseEvidenceSchema.parse(await readJson(evidenceFile));
	const pkg = (await readJson(join(checkout, "apps/desktop/package.json"))) as {
		version?: string;
		sourceUpdateProtocol?: number;
		releaseSigningPublicKey?: string;
	};
	if (
		evidence.commit !== commit ||
		evidence.version !== pkg.version ||
		pkg.sourceUpdateProtocol !== 1
	)
		throw new Error("Release evidence must match the exact checked-out commit and version.");
	if (!pkg.releaseSigningPublicKey)
		throw new Error("Provision the trusted public update signing key before publishing.");
	const options = { cwd: checkout, authentication: true };
	const main = await run(git, ["ls-remote", "--", repository, "refs/heads/main"], options);
	if (main.split(/\s+/)[0] !== commit)
		throw new Error("Only the current remote main commit can be published.");
	const tags = await run(
		git,
		["ls-remote", "--tags", "--", repository, "refs/tags/desktop-v*"],
		options,
	);
	const latest = selectRelease(tags, "0.0.0");
	if (latest && !newer(evidence.version, latest.version))
		throw new Error(
			"Desktop releases must increase the version. Existing tags are never replaced.",
		);
	const tag = `desktop-v${evidence.version}`;
	await run(git, ["tag", "-a", tag, commit, "-m", releaseAnnotation(evidence)], options);
	await run(git, ["push", repository, `refs/tags/${tag}:refs/tags/${tag}`], options);
	const remote = await run(
		git,
		["ls-remote", "--tags", "--", repository, `refs/tags/${tag}^{}`],
		options,
	);
	if (remote.split(/\s+/)[0] !== commit) throw new Error("Remote release verification failed.");
	console.log(`Published ${tag} at ${commit}.`);
}

export async function main(args: string[]) {
	const [operation, ...rest] = args;
	if (operation === "apply" && rest.length === 2)
		return applyFromHandoff(
			z.coerce.number().int().positive().parse(rest[0]),
			z.string().uuid().parse(rest[1]),
		);
	if (operation === "recover" && !rest.length) {
		const release = await lock(updateRoot());
		try {
			await recoverInstallation(updateRoot());
		} finally {
			await release();
		}
		return;
	}
	if (
		operation === "install" &&
		(rest.length === 1 || (rest.length === 3 && rest[1] === "--adopt"))
	)
		return bootstrap(resolve(rest[0]!), rest[2]);
	if (operation === "release" && rest.length === 2)
		return publishSourceRelease(resolve(rest[0]!), resolve(rest[1]!));
	throw new Error(
		"Use source:install [--adopt <app path> | --recover] or source:release <validation-evidence.json>.",
	);
}
