import { isAbsolute, relative, sep } from "node:path";

import { serverConfig, type NpmSource, type ServerConfig } from "@repo/local-mcp-core/config";

import type { DesktopManager } from "./manager";
import {
	installNpmPackage,
	npmInstalledPackage,
	npmMetadata,
	NpmSourceError,
	npmUserArguments,
	publishedVersions,
	resolveNpmVersion,
	type NpmOptions,
} from "./npm-source";

type NpmConfig = Extract<ServerConfig, { transport: "stdio" }> & {
	npm: NonNullable<Extract<ServerConfig, { transport: "stdio" }>["npm"]>;
};
/** Package-specific setup after files are installed and before the connector starts. */
export type NpmPrepare = (
	source: NpmSource,
	packageDirectory: string,
	signal?: AbortSignal,
) => Promise<void>;

/** Re-point values inside one installed package directory at another version's directory. */
export function rebasePackagePath(value: string, from: string, to: string) {
	if (!isAbsolute(value)) return value;
	const path = relative(from, value);
	if (path === "") return to;
	return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
		? value
		: to + sep + path;
}

/**
 * Atomically replaces a connector, restoring the previous configuration when the new one fails to
 * start. Tools that appear only in the new version stay disabled until the user approves them.
 */
export async function switchConnector(
	manager: {
		listServers(): Array<{ id: string; status: string; tools: Array<{ name: string }> }>;
		replaceManagedUpdate(config: ServerConfig, expected?: ServerConfig): Promise<unknown>;
	},
	previous: ServerConfig,
	build: (knownTools: string[] | undefined) => ServerConfig,
	failure: string,
) {
	const before = manager.listServers().find((s) => s.id === previous.id);
	const knownTools =
		before?.status === "online" ? before.tools.map((tool) => tool.name) : undefined;
	const next = build(knownTools);
	const restore = async () => {
		await manager.replaceManagedUpdate(previous).catch(() => {});
		throw new NpmSourceError("start-failed", failure);
	};
	try {
		await manager.replaceManagedUpdate(next, previous);
	} catch {
		return restore();
	}
	const after = manager.listServers().find((s) => s.id === previous.id);
	if (next.enabled && after?.status !== "online") return restore();
	return {
		config: next,
		toolsAwaitingApproval:
			knownTools && after
				? after.tools.map((tool) => tool.name).filter((name) => !knownTools.includes(name))
				: [],
	};
}

/**
 * npm-sourced connectors: an AI client or the CLI selects any published version; the runtime
 * installs it in isolation, switches atomically, restores the previous version if the new one
 * fails to start, and keeps tools introduced by the new version disabled until approved.
 */
export class NpmConnectors {
	private busy = new Set<string>();
	constructor(
		private manager: Pick<
			DesktopManager,
			| "root"
			| "resources"
			| "getServerConfig"
			| "listServers"
			| "addServers"
			| "replaceManagedUpdate"
		>,
		private options: Omit<NpmOptions, "signal"> & {
			requireShrinkwrap?: boolean;
			prepare?: NpmPrepare;
		} = {},
	) {}

	private npmConfig(id: string): NpmConfig {
		const config = this.manager.getServerConfig(id);
		if (config.transport !== "stdio" || !config.npm)
			throw new NpmSourceError("not-npm", "This connector is not installed from npm.");
		return config as NpmConfig;
	}

	private async exclusive<T>(id: string, task: () => Promise<T>) {
		if (this.busy.has(id))
			throw new NpmSourceError("busy", "A version change for this connector is in progress.");
		this.busy.add(id);
		try {
			return await task();
		} finally {
			this.busy.delete(id);
		}
	}

	private async install(source: NpmConfig["npm"], signal?: AbortSignal) {
		const launch = await installNpmPackage(source, {
			root: this.manager.root,
			resources: this.manager.resources,
			registry: this.options.registry,
			requireShrinkwrap: this.options.requireShrinkwrap,
			signal,
		});
		await this.options.prepare?.(
			source,
			npmInstalledPackage(this.manager.root, source),
			signal,
		);
		return launch;
	}

	async versions(id: string) {
		const config = this.npmConfig(id);
		const metadata = await npmMetadata(config.npm.package, this.options);
		return {
			id,
			package: config.npm.package,
			current: config.npm.version,
			distTags: metadata["dist-tags"],
			versions: publishedVersions(metadata, config.npm.bin),
		};
	}

	async add(
		input: {
			id: string;
			name: string;
			package: string;
			version: string;
			bin?: string;
			args?: string[];
			env?: Record<string, string>;
			enabled?: boolean;
		},
		authorize?: () => void,
	) {
		const metadata = await npmMetadata(input.package, this.options);
		const source = resolveNpmVersion(metadata, input.version, input.bin);
		return this.exclusive(input.id, async () => {
			const launch = await this.install(source);
			authorize?.();
			const config = serverConfig.parse({
				id: input.id,
				name: input.name,
				enabled: input.enabled ?? true,
				transport: "stdio",
				command: launch.command,
				args: [...launch.args, ...(input.args ?? [])],
				env: input.env ?? {},
				npm: source,
				identity: `npm:${source.package}@${source.version}`,
			});
			await this.manager.addServers([config], false, {
				localOnly: true,
				authorize,
			});
			return this.summary(input.id);
		});
	}

	async setVersion(id: string, spec: string, authorize?: () => void) {
		const previous = this.npmConfig(id);
		const metadata = await npmMetadata(previous.npm.package, this.options);
		const source = resolveNpmVersion(metadata, spec, previous.npm.bin);
		if (
			source.version === previous.npm.version &&
			source.integrity === previous.npm.integrity
		)
			return { ...this.summary(id), changed: false };
		return this.exclusive(id, async () => {
			const launch = await this.install(source);
			authorize?.();
			const current = this.npmConfig(id);
			if (JSON.stringify(current) !== JSON.stringify(previous))
				throw new NpmSourceError(
					"changed",
					"Connector changed while the new version was downloading. Try again.",
				);
			const from = npmInstalledPackage(this.manager.root, previous.npm);
			const to = npmInstalledPackage(this.manager.root, source);
			const rebase = (value: string) => rebasePackagePath(value, from, to);
			const { toolsAwaitingApproval } = await switchConnector(
				this.manager,
				previous,
				(knownTools) =>
					serverConfig.parse({
						...previous,
						command: launch.command,
						args: [...launch.args, ...npmUserArguments(previous).map(rebase)],
						env: Object.fromEntries(
							Object.entries(previous.env).map(([key, value]) => [key, rebase(value)]),
						),
						...(previous.cwd ? { cwd: rebase(previous.cwd) } : {}),
						npm: source,
						identity: `npm:${source.package}@${source.version}`,
						generation: crypto.randomUUID(),
						// Pin today's tool set so tools introduced by the new version start disabled.
						enabledTools: previous.enabledTools ?? knownTools,
					}),
				`${source.package}@${source.version} failed to start; ${previous.npm.version} was restored.`,
			);
			return {
				...this.summary(id),
				changed: true,
				previousVersion: previous.npm.version,
				toolsAwaitingApproval,
			};
		});
	}

	private summary(id: string) {
		const config = this.npmConfig(id);
		const server = this.manager.listServers().find((s) => s.id === id);
		return {
			id,
			package: config.npm.package,
			version: config.npm.version,
			status: server?.status ?? "stopped",
		};
	}
}
