import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { parse as parseToml } from "toml";

export type DesktopClient = "codex" | "claude-code" | "claude-desktop";
export interface ClientRegistrationInput {
	client: DesktopClient;
	clientId: string;
	configPath?: string;
	nodePath: string;
	bridgePath: string;
	root: string;
}
const entryName = "laplace-desktop";
const legacyNames = ["laplace", "laplace-local"] as const;
const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
			.join(",")}}`;
	return JSON.stringify(value);
};
function map(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Client configuration must contain an object.");
	return value as Record<string, unknown>;
}

export function defaultClientConfig(client: DesktopClient) {
	if (client === "codex") return join(homedir(), ".codex", "config.toml");
	if (client === "claude-desktop") {
		if (process.platform === "darwin")
			return join(
				homedir(),
				"Library",
				"Application Support",
				"Claude",
				"claude_desktop_config.json",
			);
		if (process.platform === "win32" && process.env.APPDATA)
			return join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
		throw new Error("Choose the Claude Desktop configuration file for this operating system.");
	}
	// Claude Code has project-specific .mcp.json files. Never guess the user's project.
	throw new Error("Choose the project's .mcp.json file for Claude Code.");
}

function registration(
	input: Pick<ClientRegistrationInput, "nodePath" | "bridgePath" | "root" | "clientId">,
) {
	if (![input.nodePath, input.bridgePath, input.root].every(isAbsolute))
		throw new Error("Bridge and runtime locations must be absolute paths.");
	if (!/^[0-9a-f-]{36}$/i.test(input.clientId))
		throw new Error("Register an AI client before installing its connection.");
	return {
		command: input.nodePath,
		args: [input.bridgePath, "--root", input.root, "--client-id", input.clientId],
	};
}
async function load(input: ClientRegistrationInput) {
	const file = input.configPath ?? defaultClientConfig(input.client);
	if (!isAbsolute(file)) throw new Error("Choose an absolute client configuration path.");
	let content = "",
		exists = false;
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
			throw new Error(
				"Choose a regular client configuration file smaller than 2 MiB. For a symlink, select its target.",
			);
		content = await readFile(file, "utf8");
		exists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let document: Record<string, unknown>;
	try {
		document = content.trim()
			? map(input.client === "codex" ? parseToml(content) : JSON.parse(content))
			: {};
	} catch {
		throw new Error(
			"The existing client configuration is invalid. Fix it locally before installing the connection.",
		);
	}
	const key = input.client === "codex" ? "mcp_servers" : "mcpServers";
	const servers = document[key] === undefined ? {} : map(document[key]);
	return { file, content, exists, document, servers, key };
}

/** Returns only our nonsecret entry, never the existing client configuration. */
export async function previewClientRegistration(
	input: Omit<ClientRegistrationInput, "client"> & { client: DesktopClient | "other" },
) {
	const entry = registration(input);
	// A generic stdio configuration needs no access to another application's files.
	if (input.client === "other")
		return {
			client: input.client,
			clientId: input.clientId,
			file: "",
			source: "",
			exists: false,
			entryName,
			entry,
			conflict: false,
			legacyEntries: [],
			fingerprint: "",
			instructions:
				"Copy this entry into your AI client's MCP configuration, then restart the client.",
		};
	const current = await load({ ...input, client: input.client });
	return {
		client: input.client,
		clientId: input.clientId,
		file: current.file,
		source: current.file,
		exists: current.exists,
		entryName,
		entry,
		conflict:
			current.servers[entryName] !== undefined &&
			canonical(current.servers[entryName]) !== canonical(entry),
		legacyEntries: legacyNames.filter((name) => current.servers[name] !== undefined),
		fingerprint: createHash("sha256").update(current.content).digest("hex"),
		instructions:
			"Restart the AI client after installation. Keep Laplace Desktop running. A backup is created before an existing configuration is changed.",
	};
}

function headerPath(header: string): string[] | undefined {
	try {
		let parsed: unknown = parseToml(`${header}\n__laplace_header_probe = true\n`);
		const path: string[] = [];
		while (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const entries = Object.entries(parsed);
			if (entries.length !== 1) return;
			if (entries[0]![0] === "__laplace_header_probe") return path;
			path.push(entries[0]![0]);
			parsed = entries[0]![1];
		}
	} catch {
		/* Unsupported header styles are rejected by semantic verification below. */
	}
}

export function updateCodexConfiguration(
	content: string,
	entry: { command: string; args: string[] },
	removeLegacy: readonly string[] = [],
) {
	const parsed = content.trim() ? map(parseToml(content)) : {};
	const servers = parsed.mcp_servers === undefined ? {} : { ...map(parsed.mcp_servers) };
	const replace = new Set([entryName, ...removeLegacy]);
	const headers = [...content.matchAll(/^\s*\[[^\n]+\][ \t]*(?:#[^\n]*)?$/gm)].map((match) => ({
		start: match.index!,
		end: match.index! + match[0].length,
		path: headerPath(match[0]),
	}));
	const removals: Array<{ start: number; end: number }> = [];
	for (let index = 0; index < headers.length; index++) {
		const header = headers[index]!;
		if (header.path?.[0] === "mcp_servers" && header.path[1] && replace.has(header.path[1]))
			removals.push({ start: header.start, end: headers[index + 1]?.start ?? content.length });
	}
	let updated = content;
	for (const range of removals.reverse())
		updated = updated.slice(0, range.start) + updated.slice(range.end);
	updated = `${updated.trimEnd()}\n\n[mcp_servers.${entryName}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
	for (const name of removeLegacy) delete servers[name];
	servers[entryName] = entry;
	const expected = { ...parsed, mcp_servers: servers };
	let actual: unknown;
	try {
		actual = parseToml(updated);
	} catch {
		throw new Error(
			"This Codex file uses an unsupported inline or dotted MCP table. Convert only the selected entry to a standard [mcp_servers.name] table and retry.",
		);
	}
	if (canonical(expected) !== canonical(actual))
		throw new Error(
			"Unable to update this Codex file while preserving unrelated settings. Use a standard [mcp_servers.name] table for the selected entry.",
		);
	return updated.trimStart();
}

export async function registerClient(
	input: ClientRegistrationInput & {
		replace?: boolean;
		removeLegacy?: Array<"laplace" | "laplace-local">;
		fingerprint?: string;
	},
) {
	const current = await load(input);
	const entry = registration(input);
	if (
		input.fingerprint &&
		createHash("sha256").update(current.content).digest("hex") !== input.fingerprint
	)
		throw new Error("The client configuration changed. Preview it again.");
	if (
		current.servers[entryName] !== undefined &&
		canonical(current.servers[entryName]) !== canonical(entry) &&
		!input.replace
	)
		throw new Error(
			"A different Laplace Desktop connection exists. Review it and explicitly choose replacement.",
		);
	const removeLegacy = input.removeLegacy ?? [];
	if (removeLegacy.some((name) => !legacyNames.includes(name)))
		throw new Error("Only explicitly selected legacy Laplace entries can be replaced.");
	const servers: Record<string, unknown> = { ...current.servers, [entryName]: entry };
	for (const name of removeLegacy) delete servers[name];
	const updated =
		input.client === "codex"
			? updateCodexConfiguration(current.content, entry, removeLegacy)
			: `${JSON.stringify({ ...current.document, [current.key]: servers }, null, 2)}\n`;
	if (updated === current.content)
		return { file: current.file, registered: entryName, unchanged: true };
	await mkdir(dirname(current.file), { recursive: true, mode: 0o700 });
	let backupFile: string | undefined;
	if (current.exists) {
		backupFile = `${current.file}.laplace-backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
		await writeFile(backupFile, current.content, { mode: 0o600, flag: "wx" });
	}
	const temporary = `${current.file}.laplace-${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
		const latest = await readFile(current.file, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
		if (latest !== current.content)
			throw new Error(
				"Another application changed the configuration. Your original file and backup were preserved; preview again.",
			);
		await rename(temporary, current.file);
	} finally {
		await rm(temporary, { force: true });
	}
	return {
		file: current.file,
		backupFile,
		registered: entryName,
		removedLegacy: removeLegacy,
		instructions: "Restart the AI client, then check that Laplace Desktop is available.",
	};
}

/** Desktop writes the same nonsecret registration consumed by the packaged plugin launcher. */
export async function configurePluginBridge(
	input: Pick<ClientRegistrationInput, "nodePath" | "bridgePath" | "root" | "clientId">,
) {
	const file =
		process.env.LAPLACE_PLUGIN_BRIDGE_CONFIG ??
		join(homedir(), ".laplace-desktop", "plugin-bridge.json");
	if (!isAbsolute(file)) throw new Error("Plugin bridge configuration must be an absolute path");
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(registration(input)), { mode: 0o600, flag: "wx" });
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
	return file;
}
