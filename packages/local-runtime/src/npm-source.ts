import {
	open,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
	minimalEnvironment,
	npmSource,
	type NpmSource,
} from "@repo/local-mcp-core/config";
import { spawnLocal, stopTree } from "@repo/local-mcp-core/process";
import semver from "semver";
import { z } from "zod";

/**
 * On by default on every desktop platform (catalog connectors are distributed through npm);
 * LAPLACE_NPM_CONNECTORS_V1=false switches off the AI-client npm tools.
 */
export const npmConnectorsEnabled = () => process.env.LAPLACE_NPM_CONNECTORS_V1 !== "false";
export const NPM_REGISTRY = "https://registry.npmjs.org";
/** Laplace-published connectors must pin their whole dependency tree with npm-shrinkwrap.json. */
export const LAPLACE_NPM_SCOPES = ["@laplace/", "@withlaplace/"];
const INSTALL_TIMEOUT_MS = 180_000;
const RECEIPT = ".laplace-npm.json";

export class NpmSourceError extends Error {
	constructor(
		readonly code:
			| "unknown-package"
			| "unknown-version"
			| "invalid-version"
			| "unknown-bin"
			| "registry"
			| "install"
			| "integrity"
			| "shrinkwrap"
			| "cancelled"
			| "not-npm"
			| "busy"
			| "changed"
			| "start-failed",
		message: string,
	) {
		super(message);
		this.name = "NpmSourceError";
	}
}

const packument = z.object({
	name: z.string(),
	"dist-tags": z.record(z.string(), z.string()).default({}),
	versions: z.record(
		z.string(),
		z.object({
			bin: z
				.union([z.string(), z.record(z.string(), z.string())])
				.optional(),
			deprecated: z.string().optional(),
			dist: z.object({ integrity: z.string().optional() }).passthrough(),
		}),
	),
});
export type NpmMetadata = z.infer<typeof packument>;

export type NpmOptions = {
	registry?: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
};

function registryBase(registry = NPM_REGISTRY) {
	return registry.replace(/\/+$/, "");
}

export const packageName = npmSource.shape.package;

/** Abbreviated registry metadata: versions, dist-tags, bin maps and tarball integrity. */
export async function npmMetadata(
	name: string,
	options: NpmOptions = {},
): Promise<NpmMetadata> {
	packageName.parse(name);
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(
			`${registryBase(options.registry)}/${name.replace("/", "%2F")}`,
			{
				headers: { accept: "application/vnd.npm.install-v1+json" },
				redirect: "error",
				signal: options.signal ?? AbortSignal.timeout(30_000),
			},
		);
	} catch {
		throw new NpmSourceError(
			"registry",
			"The npm registry could not be reached.",
		);
	}
	if (response.status === 404)
		throw new NpmSourceError(
			"unknown-package",
			`${name} is not published on npm.`,
		);
	if (!response.ok)
		throw new NpmSourceError(
			"registry",
			"The npm registry request failed.",
		);
	const parsed = packument.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success || parsed.data.name !== name)
		throw new NpmSourceError(
			"registry",
			"The npm registry returned invalid metadata.",
		);
	return parsed.data;
}

function binMap(
	name: string,
	bin: string | Record<string, string> | undefined,
) {
	if (typeof bin === "string") return { [name.split("/").pop()!]: bin };
	return bin ?? {};
}

/** Accepts an exact version or a dist-tag (resolved now); never a range. */
export function resolveNpmVersion(
	metadata: NpmMetadata,
	spec: string,
	bin?: string,
): NpmSource {
	const version = metadata["dist-tags"][spec] ?? spec;
	if (!semver.valid(version) || semver.clean(version) !== version)
		throw new NpmSourceError(
			"invalid-version",
			"Choose an exact published version (for example 1.2.3) or a dist-tag such as latest.",
		);
	const entry = metadata.versions[version];
	if (!entry)
		throw new NpmSourceError(
			"unknown-version",
			`${metadata.name}@${version} is not published.`,
		);
	const bins = binMap(metadata.name, entry.bin);
	const names = Object.keys(bins);
	const selected = bin ?? (names.length === 1 ? names[0] : undefined);
	if (!selected || !Object.hasOwn(bins, selected))
		throw new NpmSourceError(
			"unknown-bin",
			names.length
				? `Choose one of this package's commands: ${names.join(", ")}.`
				: "This package does not provide a command to run.",
		);
	return npmSource.parse({
		package: metadata.name,
		version,
		bin: selected,
		integrity: entry.dist.integrity,
	});
}

/** Newest first, stable before prereleases of the same version. */
export function publishedVersions(metadata: NpmMetadata, bin?: string, limit = 50) {
	return Object.keys(metadata.versions)
		.filter((version) => semver.valid(version))
		.filter(
			// Hides npm's staged-publishing placeholders and builds without this connector's command.
			(version) =>
				!bin || Object.hasOwn(binMap(metadata.name, metadata.versions[version]!.bin), bin),
		)
		.sort(semver.rcompare)
		.slice(0, limit)
		.map((version) => ({
			version,
			...(metadata.versions[version]!.deprecated ? { deprecated: true } : {}),
		}));
}

/** Never consume the user's npm credentials, configuration, or lifecycle scripts. */
export function npmEnvironment(
	root: string,
	scratch: string,
	registry = NPM_REGISTRY,
) {
	return {
		...minimalEnvironment(homedir(), {}),
		npm_config_userconfig: join(scratch, "empty.npmrc"),
		npm_config_globalconfig: join(scratch, "empty-global.npmrc"),
		npm_config_cache: join(root, "npm-cache"),
		npm_config_registry: registryBase(registry) + "/",
		npm_config_ignore_scripts: "true",
		npm_config_update_notifier: "false",
		npm_config_fund: "false",
		npm_config_audit: "false",
		npm_config_fetch_retries: "5",
		npm_config_fetch_retry_mintimeout: "2000",
	};
}

export function npmPackageDirectory(
	root: string,
	source: Pick<NpmSource, "package" | "version">,
) {
	return join(
		root,
		"npm-packages",
		source.package.replace("/", "+"),
		source.version,
	);
}

/** The installed package itself (where its package.json and bin files live). */
export function npmInstalledPackage(
	root: string,
	source: Pick<NpmSource, "package" | "version">,
) {
	return join(
		npmPackageDirectory(root, source),
		"node_modules",
		...source.package.split("/"),
	);
}

function inside(parent: string, child: string) {
	const path = relative(parent, child);
	return (
		!!path &&
		path !== ".." &&
		!path.startsWith(`..${sep}`) &&
		!isAbsolute(path)
	);
}

async function installedBin(directory: string, source: NpmSource) {
	const packageDirectory = join(
		directory,
		"node_modules",
		...source.package.split("/"),
	);
	const manifest = JSON.parse(
		await readFile(join(packageDirectory, "package.json"), "utf8"),
	);
	if (manifest.name !== source.package || manifest.version !== source.version)
		throw new NpmSourceError(
			"integrity",
			"Installed package does not match the selection.",
		);
	const target = binMap(source.package, manifest.bin)[source.bin];
	if (!target)
		throw new NpmSourceError(
			"unknown-bin",
			"Installed package lacks that command.",
		);
	const file = resolve(packageDirectory, target);
	if (!inside(packageDirectory, file) || !(await stat(file)).isFile())
		throw new NpmSourceError(
			"unknown-bin",
			"The package command is outside the package.",
		);
	return { packageDirectory, file };
}

async function verifyLock(
	directory: string,
	source: NpmSource,
	registry: string,
) {
	const lock = JSON.parse(
		await readFile(join(directory, "package-lock.json"), "utf8"),
	);
	const top = lock.packages?.[`node_modules/${source.package}`];
	if (top?.version !== source.version || top?.integrity !== source.integrity)
		throw new NpmSourceError(
			"integrity",
			"Downloaded package integrity did not match npm.",
		);
	const prefix = registryBase(registry) + "/";
	for (const [path, entry] of Object.entries(lock.packages ?? {}) as Array<
		[
			string,
			{
				resolved?: string;
				integrity?: string;
				inBundle?: boolean;
				link?: boolean;
			},
		]
	>) {
		if (!path || entry.inBundle) continue;
		if (
			entry.link ||
			!entry.resolved?.startsWith(prefix) ||
			!entry.integrity?.startsWith("sha512-")
		)
			throw new NpmSourceError(
				"integrity",
				"A dependency did not come from the npm registry.",
			);
	}
}

function runNpm(
	args: string[],
	cwd: string,
	env: Record<string, string>,
	resources: string,
	signal?: AbortSignal,
) {
	return new Promise<void>((accept, reject) => {
		const child = spawnLocal(
			process.execPath,
			[join(resources, "runtimes", "npm", "bin", "npm-cli.js"), ...args],
			cwd,
			env,
			resources,
		);
		child.stdin.end();
		child.stdout.resume();
		child.stderr.resume();
		const abort = (code: "cancelled" | "install") => {
			void stopTree(child);
			reject(
				new NpmSourceError(
					code,
					code === "cancelled"
						? "Installation cancelled."
						: "npm install timed out.",
				),
			);
		};
		const onAbort = () => abort("cancelled");
		const timer = setTimeout(() => abort("install"), INSTALL_TIMEOUT_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", () =>
			reject(new NpmSourceError("install", "npm could not start.")),
		);
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (code === 0) accept();
			else reject(new NpmSourceError("install", "npm install failed."));
		});
		if (signal?.aborted) onAbort();
	});
}

export type NpmInstallation = {
	directory: string;
	command: string;
	args: string[];
};

/**
 * Installs one exact version into its own directory. Existing verified installations are reused,
 * so switching back to a previous version needs no network.
 */
export async function installNpmPackage(
	source: NpmSource,
	options: {
		root: string;
		resources: string;
		registry?: string;
		requireShrinkwrap?: boolean;
		signal?: AbortSignal;
		/** Reinstall even when a verified installation exists (repair). */
		force?: boolean;
	},
): Promise<NpmInstallation> {
	npmSource.parse(source);
	const registry = options.registry ?? NPM_REGISTRY;
	const requireShrinkwrap =
		options.requireShrinkwrap ??
		LAPLACE_NPM_SCOPES.some((scope) => source.package.startsWith(scope));
	const directory = npmPackageDirectory(options.root, source);
	const receipt = JSON.stringify({
		package: source.package,
		version: source.version,
		integrity: source.integrity,
	});
	let reuse = false;
	try {
		reuse =
			!options.force &&
			(await readFile(join(directory, RECEIPT), "utf8")) === receipt;
	} catch {}
	if (!reuse) {
		const staging = `${directory}.staging`;
		await rm(staging, { recursive: true, force: true });
		await mkdir(staging, { recursive: true, mode: 0o700 });
		try {
			await writeFile(
				join(staging, "package.json"),
				JSON.stringify({
					private: true,
					dependencies: { [source.package]: source.version },
				}),
			);
			await runNpm(
				[
					"install",
					"--omit=dev",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--save-exact",
				],
				staging,
				npmEnvironment(options.root, staging, registry),
				options.resources,
				options.signal,
			);
			await verifyLock(staging, source, registry);
			const { packageDirectory } = await installedBin(staging, source);
			if (requireShrinkwrap)
				await stat(join(packageDirectory, "npm-shrinkwrap.json")).catch(
					() => {
						throw new NpmSourceError(
							"shrinkwrap",
							"Laplace connectors must publish npm-shrinkwrap.json.",
						);
					},
				);
			await writeFile(join(staging, RECEIPT), receipt, { mode: 0o600 });
			await rm(directory, { recursive: true, force: true });
			await rename(staging, directory);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
	const { file } = await installedBin(directory, source);
	return { directory, ...(await launchFor(file)) };
}

/** JavaScript bins run on the bundled Node; native bins run directly. */
async function launchFor(file: string) {
	if ([".js", ".cjs", ".mjs"].includes(extname(file)))
		return { command: "node", args: [file] };
	const handle = await open(file, "r");
	try {
		const { buffer, bytesRead } = await handle.read(
			Buffer.alloc(128),
			0,
			128,
			0,
		);
		const first = buffer
			.subarray(0, bytesRead)
			.toString("utf8")
			.split("\n")[0]!;
		if (first.startsWith("#!") && /\bnode\b/.test(first))
			return { command: "node", args: [file] };
	} finally {
		await handle.close();
	}
	return { command: file, args: [] };
}

/** User arguments that follow the package's own launch arguments. */
export function npmUserArguments(config: { command: string; args: string[] }) {
	return config.args.slice(config.command === "node" ? 1 : 0);
}
