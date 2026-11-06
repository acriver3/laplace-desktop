import { localId, toolName } from "@repo/project-protocol/local-mcp";
import { z } from "zod";

export const loopbackUrl = z
	.string()
	.url()
	.refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === "http:" &&
			["127.0.0.1", "[::1]"].includes(url.hostname) &&
			!url.username &&
			!url.password &&
			!url.hash
		);
	}, "Use an explicit loopback HTTP address (127.0.0.1 or [::1])");
const common = {
	// Only managed installation writes this receipt; arbitrary imports cannot claim it.
	managedBrowser: z
		.object({
			catalogId: z.string().min(1).max(100),
			provider: z.enum(["outlook", "slack", "slack-tethered", "linkedin", "ycombinator"]),
			workspace: z.string().url().max(2048),
			artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
			runtimeVersion: z.string().min(1).max(100),
		})
		.strict()
		.optional(),
	// Omission preserves existing connector startup and never probes a second process.
	protocolVersion: z.literal("2026-07-28").optional(),
	generation: z
		.string()
		.uuid()
		.default(() => crypto.randomUUID()),
	id: localId,
	name: z.string().min(1).max(120),
	enabled: z.boolean().default(true),
	catalog: z.literal("custom").default("custom"),
	identity: z.string().max(200).optional(),
	enabledTools: z.array(toolName).max(300).optional(),
};
/** Runtime-installed npm package receipt; launch fields are derived from it, never supplied. */
export const npmSource = z
	.object({
		package: z
			.string()
			.max(214)
			.regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/),
		version: z
			.string()
			.max(100)
			.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
		bin: z
			.string()
			.min(1)
			.max(214)
			.regex(/^[A-Za-z0-9@._-]+$/),
		integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
	})
	.strict();
export type NpmSource = z.infer<typeof npmSource>;
export const serverConfig = z.discriminatedUnion("transport", [
	z
		.object({
			...common,
			transport: z.literal("stdio"),
			command: z
				.string()
				.min(1)
				.max(4096)
				.refine((s) => !s.includes("\0")),
			args: z
				.array(
					z
						.string()
						.max(8000)
						.refine((s) => !s.includes("\0")),
				)
				.max(100)
				.default([]),
			cwd: z.string().min(1).max(4096).optional(),
			env: z
				.record(
					z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
					z
						.string()
						.max(32000)
						.refine((s) => !s.includes("\0")),
				)
				.default({}),
			npm: npmSource.optional(),
		})
		.strict(),
	z
		.object({
			...common,
			transport: z.literal("http"),
			url: loopbackUrl,
			headers: z.record(z.string(), z.string().max(8000)).default({}),
		})
		.strict(),
]);
export type ServerConfig = z.infer<typeof serverConfig>;
export function importMcpConfiguration(value: unknown): ServerConfig[] {
	const input = z
		.object({
			mcpServers: z.record(localId, z.unknown()).refine((v) => Object.keys(v).length <= 50),
		})
		.strict()
		.parse(value);
	return Object.entries(input.mcpServers).map(([id, value]) => {
		const entry = z
			.object({
				command: z.string().optional(),
				args: z.array(z.string()).optional(),
				cwd: z.string().optional(),
				env: z.record(z.string(), z.string()).optional(),
				url: z.string().optional(),
				headers: z.record(z.string(), z.string()).optional(),
				type: z.enum(["stdio", "http", "streamable-http"]).optional(),
				disabled: z.boolean().optional(),
				protocolVersion: z.literal("2026-07-28").optional(),
			})
			.strict()
			.parse(value);
		if (entry.command && entry.url) throw new Error("Choose one transport per server");
		return serverConfig.parse(
			entry.url
				? {
						id,
						name: id,
						enabled: !entry.disabled,
						transport: "http",
						url: entry.url,
						headers: entry.headers,
						...(entry.protocolVersion ? { protocolVersion: entry.protocolVersion } : {}),
					}
				: {
						id,
						name: id,
						enabled: !entry.disabled,
						transport: "stdio",
						command: entry.command,
						args: entry.args,
						cwd: entry.cwd,
						env: entry.env,
						...(entry.protocolVersion ? { protocolVersion: entry.protocolVersion } : {}),
					},
		);
	});
}
export function minimalEnvironment(
	home: string,
	extras: Record<string, string> = {},
	base = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of [
		"PATH",
		"Path",
		"SystemRoot",
		"WINDIR",
		"COMSPEC",
		"TEMP",
		"TMP",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"USERPROFILE",
		"APPDATA",
		"LOCALAPPDATA",
	])
		if (base[key]) environment[key] = base[key]!;
	return { ...environment, HOME: home, ...extras };
}

/** Resolve only explicit aliases to bundled runtimes; custom paths stay literal. */
export function runtimeCommand(
	command: string,
	args: string[],
	resources: string,
): { command: string; args: string[] } {
	const suffix = process.platform === "win32" ? ".exe" : "";
	const base = resources.replace(/[\\/]$/, "") + "/runtimes/";
	if (command === "node") return { command: process.execPath, args };
	if (command === "uv") return { command: base + "uv" + suffix, args };
	if (command === "uvx") return { command: base + "uv" + suffix, args: ["tool", "run", ...args] };
	if (command === "npm" || command === "npx")
		return { command: process.execPath, args: [base + `npm/bin/${command}-cli.js`, ...args] };
	return { command, args };
}
