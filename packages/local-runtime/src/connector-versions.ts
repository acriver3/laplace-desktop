import { serverConfig, type ServerConfig } from "@repo/local-mcp-core/config";

import type { DesktopManager } from "./manager";
import {
	installNpmPackage,
	npmMetadata,
	npmUserArguments,
	publishedVersions,
	resolveNpmVersion,
	type NpmOptions,
} from "./npm-source";

type NpmConfig = Extract<ServerConfig, { transport: "stdio" }> & {
	npm: NonNullable<Extract<ServerConfig, { transport: "stdio" }>["npm"]>;
};

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
		} = {},
	) {}

	private npmConfig(id: string): NpmConfig {
		const config = this.manager.getServerConfig(id);
		if (config.transport !== "stdio" || !config.npm)
			throw new Error("This connector is not installed from npm.");
		return config as NpmConfig;
	}

	private async exclusive<T>(id: string, task: () => Promise<T>) {
		if (this.busy.has(id))
			throw new Error(
				"A version change for this connector is in progress.",
			);
		this.busy.add(id);
		try {
			return await task();
		} finally {
			this.busy.delete(id);
		}
	}

	private install(source: NpmConfig["npm"], signal?: AbortSignal) {
		return installNpmPackage(source, {
			root: this.manager.root,
			resources: this.manager.resources,
			registry: this.options.registry,
			requireShrinkwrap: this.options.requireShrinkwrap,
			signal,
		});
	}

	async versions(id: string) {
		const config = this.npmConfig(id);
		const metadata = await npmMetadata(config.npm.package, this.options);
		return {
			id,
			package: config.npm.package,
			current: config.npm.version,
			distTags: metadata["dist-tags"],
			versions: publishedVersions(metadata),
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
				throw new Error(
					"Connector changed while the new version was downloading. Try again.",
				);
			const before = this.manager.listServers().find((s) => s.id === id);
			const knownTools =
				before?.status === "online"
					? before.tools.map((tool) => tool.name)
					: undefined;
			const next = serverConfig.parse({
				...previous,
				command: launch.command,
				args: [...launch.args, ...npmUserArguments(previous)],
				npm: source,
				identity: `npm:${source.package}@${source.version}`,
				generation: crypto.randomUUID(),
				// Pin today's tool set so tools introduced by the new version start disabled.
				enabledTools: previous.enabledTools ?? knownTools,
			});
			try {
				await this.manager.replaceManagedUpdate(next, previous);
			} catch {
				await this.manager
					.replaceManagedUpdate(previous)
					.catch(() => {});
				throw new Error(
					`${source.package}@${source.version} failed to start; ${previous.npm.version} was restored.`,
				);
			}
			const after = this.manager.listServers().find((s) => s.id === id);
			if (next.enabled && after?.status !== "online") {
				await this.manager
					.replaceManagedUpdate(previous)
					.catch(() => {});
				throw new Error(
					`${source.package}@${source.version} failed to start; ${previous.npm.version} was restored.`,
				);
			}
			const approval =
				knownTools && after
					? after.tools
							.map((tool) => tool.name)
							.filter((name) => !knownTools.includes(name))
					: [];
			return {
				...this.summary(id),
				changed: true,
				previousVersion: previous.npm.version,
				toolsAwaitingApproval: approval,
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
