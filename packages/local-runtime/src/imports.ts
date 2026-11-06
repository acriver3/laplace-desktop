import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
	importMcpConfiguration,
	runtimeCommand,
	serverConfig,
	type ServerConfig,
} from "@repo/local-mcp-core/config";
import { parse as parseToml } from "toml";

export type ImportFormat = "json" | "toml";
export interface ImportEntryPreview {
	protocolVersion?: "2026-07-28";
	id: string;
	name: string;
	transport?: "stdio" | "http";
	command?: string;
	args?: string[];
	argumentCount?: number;
	cwd?: string;
	resolvedCommand?: string;
	resolvedArgs?: string[];
	resolvedDirectory?: string;
	url?: string;
	secretKeys?: string[];
	enabled?: boolean;
	error?: string;
}
export interface ImportPreview {
	source: string;
	fingerprint: string;
	entries: ImportEntryPreview[];
}
export interface LaunchReviewOptions {
	root: string;
	resources: string;
	environment?: NodeJS.ProcessEnv;
}
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const reserved = new Set(["laplace", "laplace-local", "laplace-desktop"]);
const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected a configuration object.");
	return value as Record<string, unknown>;
};

function environmentValue(name: unknown, env: NodeJS.ProcessEnv) {
	if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
		throw new Error("Invalid environment variable reference.");
	const value = env[name];
	if (value === undefined)
		throw new Error(
			`Environment variable ${name} is unavailable to the desktop helper. Enter it in the local configuration instead.`,
		);
	return value;
}

function normalizeEntry(
	id: string,
	raw: unknown,
	format: ImportFormat,
	baseDirectory: string,
	environment: NodeJS.ProcessEnv,
): ServerConfig {
	if (reserved.has(id)) throw new Error("The Laplace connection cannot be imported into itself.");
	const entry = { ...object(raw) };
	if (format === "toml") {
		const supported = new Set([
			"protocolVersion",
			"command",
			"args",
			"cwd",
			"env",
			"env_vars",
			"url",
			"http_headers",
			"env_http_headers",
			"bearer_token_env_var",
			"enabled",
		]);
		if (Object.keys(entry).some((key) => !supported.has(key)))
			throw new Error(
				"This entry contains unsupported Codex settings. Review its launch, timeout, or tool restrictions before importing.",
			);
		const env = entry.env === undefined ? {} : { ...object(entry.env) };
		if (entry.env_vars !== undefined) {
			if (!Array.isArray(entry.env_vars)) throw new Error("env_vars must be an array.");
			for (const name of entry.env_vars) env[String(name)] = environmentValue(name, environment);
		}
		const headers = entry.http_headers === undefined ? {} : { ...object(entry.http_headers) };
		if (entry.env_http_headers !== undefined) {
			for (const [name, variable] of Object.entries(object(entry.env_http_headers)))
				headers[name] = environmentValue(variable, environment);
		}
		if (entry.bearer_token_env_var !== undefined) {
			if (Object.keys(headers).some((key) => key.toLowerCase() === "authorization"))
				throw new Error("Conflicting authorization header sources.");
			headers.Authorization = `Bearer ${environmentValue(entry.bearer_token_env_var, environment)}`;
		}
		if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
			throw new Error("enabled must be a boolean.");
		for (const key of [
			"env_vars",
			"http_headers",
			"env_http_headers",
			"bearer_token_env_var",
			"enabled",
		])
			delete entry[key];
		if (Object.keys(env).length) entry.env = env;
		if (Object.keys(headers).length) entry.headers = headers;
		entry.disabled = object(raw).enabled === false;
	}
	if (typeof entry.cwd === "string") entry.cwd = resolve(baseDirectory, entry.cwd);
	if (entry.url && (entry.env || entry.cwd || entry.args || entry.type === "stdio"))
		throw new Error("HTTP entries cannot include process launch settings.");
	if (entry.command && (entry.headers || entry.type === "http" || entry.type === "streamable-http"))
		throw new Error("Stdio entries cannot include HTTP settings.");
	if (
		typeof entry.command === "string" &&
		!isAbsolute(entry.command) &&
		/[/\\]/.test(entry.command)
	)
		entry.command = resolve(
			typeof entry.cwd === "string" ? entry.cwd : baseDirectory,
			entry.command,
		);
	if (
		typeof entry.command === "string" &&
		/(?:^|[/\\])laplace-(?:local|desktop)(?:\.(?:cmd|exe))?$/.test(entry.command)
	)
		throw new Error("The Laplace connection cannot be imported into itself.");
	if (
		Array.isArray(entry.args) &&
		entry.args.some(
			(arg) =>
				typeof arg === "string" &&
				/(?:^|[/\\])(?:bridge\.(?:cjs|mjs)|laplace-local)(?:$|[/\\])/.test(arg),
		)
	)
		throw new Error("A Laplace bridge cannot be imported into itself.");
	return importMcpConfiguration({ mcpServers: { [id]: entry } })[0]!;
}

function parseDocument(text: string, format: ImportFormat) {
	if (Buffer.byteLength(text) > MAX_CONFIG_BYTES)
		throw new Error("Configuration exceeds the 2 MiB limit.");
	let parsed: Record<string, unknown>;
	try {
		parsed = object(format === "toml" ? parseToml(text) : JSON.parse(text));
	} catch {
		throw new Error(
			`Unable to parse ${format.toUpperCase()} configuration. Check the file locally.`,
		);
	}
	const entries = object(parsed[format === "toml" ? "mcp_servers" : "mcpServers"]);
	if (Object.keys(entries).length > 100)
		throw new Error("Configuration contains more than 100 servers.");
	return entries;
}

/** Human-readable review of launch arguments, with common credential forms removed. */
export function redactArguments(args: string[], secrets: string[] = []) {
	let redactNext = false;
	return args.map((argument) => {
		if (redactNext) {
			redactNext = false;
			return "••••";
		}
		if (
			/^--?(?:.*(?:token|password|passwd|secret|credential|authorization|cookie|api[-_]?key|private[-_]?key)|p)$/i.test(
				argument,
			)
		) {
			redactNext = true;
			return argument;
		}
		let value = argument
			.replace(
				/((?:token|password|passwd|secret|credential|authorization|cookie|api[-_]?key|private[-_]?key)[\w-]*[=:]\s*)[^\s]+/gi,
				"$1••••",
			)
			.replace(/\bBearer\s+\S+/gi, "Bearer ••••");
		if (/^(?:xox[bcp]-|sk-[a-zA-Z0-9]|eyJ[a-zA-Z0-9_-]+\.)/.test(value)) value = "••••";
		try {
			const url = new URL(value);
			if (["http:", "https:"].includes(url.protocol)) {
				if (url.username) url.username = "redacted";
				if (url.password) url.password = "redacted";
				for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "redacted");
				value = url.href;
			}
		} catch {
			/* Ordinary command argument. */
		}
		for (const secret of secrets) if (secret.length >= 4) value = value.replaceAll(secret, "••••");
		return value;
	});
}

export function configurationSummary(config: ServerConfig): ImportEntryPreview {
	return config.transport === "stdio"
		? {
				id: config.id,
				name: config.name,
				transport: config.transport,
				protocolVersion: config.protocolVersion,
				command: config.command,
				args: redactArguments(config.args, Object.values(config.env)),
				argumentCount: config.args.length,
				cwd: config.cwd,
				secretKeys: Object.keys(config.env),
				enabled: config.enabled,
			}
		: {
				id: config.id,
				name: config.name,
				transport: config.transport,
				protocolVersion: config.protocolVersion,
				url: new URL(config.url).origin + new URL(config.url).pathname,
				secretKeys: Object.keys(config.headers),
				enabled: config.enabled,
			};
}

/** Resolve the same runtime aliases and PATH as ManagedStdio, without launching anything. */
export async function previewLaunch(
	config: ServerConfig,
	options: LaunchReviewOptions,
): Promise<ImportEntryPreview> {
	const summary = configurationSummary(config);
	if (config.transport !== "stdio") return summary;
	const directory = config.cwd ?? join(options.root, "servers", config.id);
	const launch = runtimeCommand(config.command, config.args, options.resources);
	const secrets = Object.values(config.env);
	summary.resolvedDirectory = directory;
	summary.resolvedArgs = redactArguments(launch.args, secrets);
	try {
		if (config.cwd) {
			if (!(await stat(directory)).isDirectory())
				throw new Error("The working directory is not a folder.");
			await access(directory, process.platform === "win32" ? constants.R_OK : constants.X_OK);
		}
	} catch {
		return {
			...summary,
			error:
				"The configured working directory is missing or inaccessible. Choose an existing folder before activation.",
		};
	}
	if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(launch.command)) {
		return {
			...summary,
			error:
				"Windows command scripts cannot run directly. Choose an executable or use a bundled node, npm, npx, uv, or uvx alias.",
		};
	}
	const windows = process.platform === "win32";
	const containsPath =
		isAbsolute(launch.command) ||
		/[/\\]/.test(launch.command) ||
		(windows && /^[A-Za-z]:/.test(launch.command));
	const command =
		windows && !containsPath && !extname(launch.command) ? `${launch.command}.exe` : launch.command;
	const environment = options.environment ?? process.env;
	const path = [
		join(options.resources, "runtimes"),
		dirname(process.execPath),
		config.env.PATH ?? environment.PATH ?? "",
	].join(delimiter);
	const systemRoot = config.env.SystemRoot ?? environment.SystemRoot;
	const windowsSearch = windows
		? [
				join(options.resources, "runtimes"),
				directory,
				...(systemRoot
					? [join(systemRoot, "System32"), join(systemRoot, "System"), systemRoot]
					: []),
			]
		: [];
	const candidates = containsPath
		? [resolve(directory, command)]
		: [...windowsSearch, ...path.split(delimiter).map((entry) => entry || directory)].map((entry) =>
				resolve(directory, entry, command),
			);
	for (const candidate of candidates) {
		try {
			if (!(await stat(candidate)).isFile()) continue;
			await access(candidate, windows ? constants.R_OK : constants.X_OK);
			summary.resolvedCommand = redactArguments([candidate], secrets)[0];
			break;
		} catch {
			/* Try the next PATH location without executing the candidate. */
		}
	}
	if (!summary.resolvedCommand)
		return {
			...summary,
			error:
				"The executable could not be found or is not executable. Install it or choose its absolute path before activation.",
		};
	if (config.command === "npm" || config.command === "npx") {
		try {
			if (!(await stat(launch.args[0]!)).isFile()) throw new Error();
			await access(launch.args[0]!, constants.R_OK);
		} catch {
			return {
				...summary,
				error:
					"The bundled npm runtime is incomplete. Prepare the desktop runtimes before activation.",
			};
		}
	}
	return summary;
}

/** Existing credentials remain in the helper; only their names/redacted arguments are returned. */
export async function previewManualConfiguration(
	input: unknown,
	options: LaunchReviewOptions,
	previous?: ServerConfig,
) {
	const patch = object(input);
	if (patch.identity !== undefined || patch.npm !== undefined)
		throw new Error("Catalog provenance cannot be assigned manually.");
	const config = normalizeManualConfiguration(
		previous ? withoutProvenance({ ...previous, ...patch, id: previous.id }) : patch,
	);
	return previewLaunch(config, options);
}

export function previewConfiguration(
	text: string,
	format: ImportFormat,
	source: string,
	environment: NodeJS.ProcessEnv = process.env,
): ImportPreview {
	const entries = parseDocument(text, format);
	return {
		source,
		fingerprint: createHash("sha256").update(text).digest("hex"),
		entries: Object.entries(entries).map(([id, entry]) => {
			try {
				return configurationSummary(
					normalizeEntry(id, entry, format, dirname(source), environment),
				);
			} catch (error) {
				return {
					id,
					name: id,
					error:
						error instanceof Error && !error.name.includes("Zod")
							? error.message
							: "This server has an invalid or unsupported configuration.",
				};
			}
		}),
	};
}

async function readConfiguration(filePath: string) {
	if (!isAbsolute(filePath)) throw new Error("Choose an absolute configuration file path.");
	const info = await stat(filePath);
	if (!info.isFile() || info.size > MAX_CONFIG_BYTES)
		throw new Error("Choose a configuration file smaller than 2 MiB.");
	return readFile(filePath, "utf8");
}

export async function previewImportFile(
	filePath: string,
	review?: LaunchReviewOptions,
): Promise<ImportPreview> {
	const text = await readConfiguration(filePath);
	const format = filePath.toLowerCase().endsWith(".toml") ? "toml" : "json";
	const preview = previewConfiguration(text, format, filePath, review?.environment);
	if (!review) return preview;
	const entries = parseDocument(text, format);
	preview.entries = await Promise.all(
		preview.entries.map(async (entry) =>
			entry.error
				? entry
				: previewLaunch(
						normalizeEntry(
							entry.id,
							entries[entry.id],
							format,
							dirname(filePath),
							review.environment ?? process.env,
						),
						review,
					),
		),
	);
	return preview;
}

export async function importSelectedFile(
	filePath: string,
	selectedIds: string[],
	fingerprint?: string,
): Promise<ServerConfig[]> {
	const text = await readConfiguration(filePath);
	if (fingerprint && createHash("sha256").update(text).digest("hex") !== fingerprint)
		throw new Error("The configuration changed. Preview it again before importing.");
	const format = filePath.toLowerCase().endsWith(".toml") ? "toml" : "json";
	const entries = parseDocument(text, format);
	if (
		!selectedIds.length ||
		selectedIds.length > 50 ||
		new Set(selectedIds).size !== selectedIds.length
	)
		throw new Error("Select between 1 and 50 distinct servers.");
	return selectedIds.map((id) => {
		if (!Object.hasOwn(entries, id))
			throw new Error("A selected server no longer exists. Preview the configuration again.");
		return normalizeEntry(id, entries[id], format, dirname(filePath), process.env);
	});
}

function withoutProvenance(value: Record<string, unknown>) {
	const { identity: _identity, npm: _npm, ...rest } = value;
	return rest;
}

export function normalizeManualConfiguration(input: unknown): ServerConfig {
	const value = object(input);
	if (value.identity !== undefined || value.npm !== undefined)
		throw new Error("Catalog provenance is assigned only by the guided installer.");
	const config = serverConfig.parse(value);
	if (reserved.has(config.id)) throw new Error("Choose a name other than a Laplace bridge name.");
	if (
		config.transport === "stdio" &&
		/(?:^|[/\\])laplace-(?:local|desktop)(?:\.(?:cmd|exe))?$/.test(config.command)
	)
		throw new Error("The Laplace connection cannot be imported into itself.");
	if (
		config.transport === "stdio" &&
		config.args.some((arg) =>
			/(?:^|[/\\])(?:bridge\.(?:cjs|mjs)|laplace-local)(?:$|[/\\])/.test(arg),
		)
	)
		throw new Error("A Laplace bridge cannot be imported into itself.");
	if (config.transport === "stdio" && config.cwd && !isAbsolute(config.cwd))
		throw new Error("Working directory must be an absolute path.");
	return config;
}
