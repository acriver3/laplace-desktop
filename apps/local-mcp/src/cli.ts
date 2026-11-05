import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { systemEntry } from "@repo/local-mcp-core/store";
import { computerIdleSeconds } from "@repo/local-mcp-core/update-idle";
import {
	UpdatePolicyStore,
	automaticUpdatesEnabled,
	updateInstanceKey,
} from "@repo/local-mcp-core/update-policy";
import { controlRequest } from "@repo/local-runtime/control";
import { launchOptions, runLauncher } from "@repo/local-runtime/launcher";
import { startRuntime } from "@repo/local-runtime/lifecycle";
import { runtimeProfile } from "@repo/local-runtime/paths";
import type { HelperMethod } from "@repo/local-runtime/shared/helper-contracts";

/** Commands the stable launcher handles without a running runtime. */
const lifecycle = new Set(["start", "stop", "enable", "disable", "install", "autostart"]);
const clientNames = {
	"claude-code": "Claude Code",
	codex: "Codex",
	"claude-desktop": "Claude Desktop",
	other: "AI client",
} as const;
type ClientKind = keyof typeof clientNames;

export type CliIo = {
	argv: string[];
	print(value: unknown): void;
	confirm(message: string): Promise<boolean>;
	openUrl?(url: string): void;
	sleep?(ms: number): Promise<void>;
	request?: (method: HelperMethod, input?: unknown) => Promise<any>;
};

/**
 * `laplace-local` / `laplace-runtime`: argument parsing and presentation only. Every operation
 * is performed by the Laplace Runtime through its control API; the CLI owns no connector state.
 */
export async function runCli(io: CliIo) {
	const argv = io.argv;
	const option = (name: string, fallback?: string) => {
		const index = argv.indexOf(name);
		return index < 0 ? fallback : argv[index + 1];
	};
	const command = argv[0];
	const profile = runtimeProfile.parse(option("--profile") ?? "hosted");
	const options = launchOptions(profile);
	const root = resolve(option("--root") ?? options.root);
	const sleep = io.sleep ?? ((ms: number) => new Promise((accept) => setTimeout(accept, ms)));
	if (!command || command === "help" || command === "--help") {
		io.print(usage);
		return;
	}
	if (command === "status" || command === "bridge" || lifecycle.has(command)) {
		io.print(await runLauncher(argv));
		return;
	}
	// Preferences remain usable while the keychain, connectors, or the runtime are unavailable.
	if (command === "updates" && ["enable", "disable", "defer"].includes(argv[1] ?? "")) {
		io.print(
			await new UpdatePolicyStore().mutate((value) => {
				if (argv[1] === "defer") value.deferredUntil = Date.now() + 86_400_000;
				else value.connectors = argv[1] === "enable";
			}),
		);
		return;
	}
	if (command === "doctor") {
		const entry = await systemEntry(root, "doctor");
		const probe = randomUUID();
		entry.setPassword(probe);
		const keychain = entry.getPassword() === probe;
		entry.deletePassword();
		io.print({
			keychain,
			...((await runLauncher(["status", "--profile", profile]).catch(() => ({}))) as object),
		});
		return;
	}
	// Everything else is a user action: start the runtime if needed (clears an explicit stop).
	const request =
		io.request ??
		(async (method: HelperMethod, input: unknown = {}) => {
			const descriptor = await startRuntime({ ...options, root, explicit: true });
			return controlRequest(descriptor, method, input);
		});
	const reviewed = async (message: string) =>
		argv.includes("--confirm") || (await io.confirm(message));

	switch (command) {
		case "serve": {
			// Stdio MCP for AI clients that launch `laplace-local serve`; shares the runtime.
			const kind = (option("--client", "other") ?? "other") as ClientKind;
			if (!(kind in clientNames)) throw new Error("Unknown client");
			const clientId = await registeredClient(root, kind, request);
			await runLauncher(["bridge", "--profile", profile, "--root", root, "--client-id", clientId]);
			return;
		}
		case "install-client": {
			const kind = argv[1] as ClientKind;
			if (!["claude-code", "codex", "claude-desktop"].includes(kind))
				throw new Error("Choose claude-code, codex, or claude-desktop");
			const configPath = option(
				"--config",
				kind === "claude-code" ? join(process.cwd(), ".mcp.json") : undefined,
			);
			const clientId = await registeredClient(root, kind, request);
			const input = {
				clientId,
				client: kind,
				...(configPath ? { configPath: resolve(configPath) } : {}),
			};
			const preview = (await request("client.preview-install", input)) as {
				conflict?: boolean;
				fingerprint?: string;
				legacyEntries?: Array<"laplace" | "laplace-local">;
			};
			const replace =
				!!preview.conflict &&
				(await reviewed("Replace the conflicting Laplace entry in this client configuration?"));
			// Older standalone CLI entries are replaced by the shared runtime registration.
			const removeLegacy = preview.legacyEntries?.includes("laplace-local")
				? (await reviewed(
						"Remove the legacy laplace-local entry that ran its own connector processes?",
					))
					? (["laplace-local"] as const)
					: undefined
				: undefined;
			io.print(
				await request("client.install", {
					...input,
					replace,
					fingerprint: preview.fingerprint,
					...(removeLegacy ? { removeLegacy } : {}),
				}),
			);
			return;
		}
		case "login": {
			let result = (await request("link.start", {
				...(option("--origin") ? { origin: option("--origin") } : {}),
				...(option("--name") ? { name: option("--name") } : {}),
			})) as { linked?: boolean; verificationUrl?: string; expiresAt?: number };
			io.print(result);
			if (result.linked) return;
			if (result.verificationUrl) io.openUrl?.(result.verificationUrl);
			const deadline = result.expiresAt ?? Date.now() + 300_000;
			while (Date.now() < deadline) {
				await sleep(5000);
				result = (await request("link.poll")) as typeof result;
				if (result.linked) break;
			}
			io.print(await request("status"));
			return;
		}
		case "logout":
			if (
				!(await reviewed("Unlink this installation from Laplace? Local connectors keep working."))
			)
				return;
			io.print(await request("link.unlink"));
			return;
		case "import":
		case "attach": {
			const file = argv[1],
				selected = option("--select")?.split(",").filter(Boolean);
			if (!file || !selected?.length)
				throw new Error(
					"Usage: import <file> --select <server-id,...> --confirm (review executable, arguments, cwd and credential sources first)",
				);
			const preview = (await request("import.preview", { file: resolve(file) })) as {
				fingerprint?: string;
			};
			io.print(preview);
			if (!(await reviewed(`Import the selected configurations from ${file}?`))) return;
			io.print(
				await request("import.apply", {
					file: resolve(file),
					selected,
					fingerprint: preview.fingerprint,
				}),
			);
			return;
		}
		case "import-legacy": {
			const legacy = option("--from", join(homedir(), ".laplace-local"))!;
			const preview = await request("migration.preview", { root: resolve(legacy) });
			const selected = option("--select")?.split(",").filter(Boolean);
			if (!selected?.length) {
				io.print({
					preview,
					next: "Review the connectors above, then rerun with --select <id,...> --confirm. They are imported disabled; the legacy store is left untouched.",
				});
				return;
			}
			if (!(await reviewed("Import the selected legacy CLI connectors (disabled)?"))) return;
			io.print(await request("migration.apply", { root: resolve(legacy), selected }));
			return;
		}
		case "repair":
		case "remove": {
			const id = argv[1];
			if (!id) throw new Error(`Usage: ${command} <connection-id> --confirm`);
			if (!(await reviewed(`${command} local connector ${id}?`))) return;
			io.print(await request(command === "repair" ? "server.restart" : "server.remove", { id }));
			return;
		}
		case "browser":
		case "approvals":
			io.print(await browser(argv, request, io, sleep));
			return;
		case "updates":
			io.print(await updates(argv, root, request));
			return;
		default:
			throw new Error(usage);
	}
}

const usage =
	"Usage: laplace-local status | start | stop | enable | disable | doctor | login [--origin] [--name] | logout | serve [--client claude-code|codex|claude-desktop|other] | install-client <claude-code|codex|claude-desktop> [--config <file>] | import <file> --select <ids> | import-legacy [--select <ids>] | repair <id> | remove <id> | browser <catalog|setup|authenticate|status|disconnect> | approvals [list|open <request-id>|cancel <request-id>] | updates <status|check|enable|disable|defer|pin|unpin|apply|enroll> [--profile hosted|local]";

/** One runtime registration per AI-client kind, so repeated `serve` launches share it. */
async function registeredClient(
	root: string,
	kind: ClientKind,
	request: (method: HelperMethod, input?: unknown) => Promise<any>,
) {
	const file = join(root, "cli-clients.json");
	const known = (await readFile(file, "utf8")
		.then(JSON.parse)
		.catch(() => ({}))) as Record<string, string>;
	const clients = (await request("client.list")) as Array<{ id: string; enabled: boolean }>;
	const existing = known[kind];
	if (existing && clients.some((client) => client.id === existing && client.enabled))
		return existing;
	const created = (await request("client.register", { name: clientNames[kind] })) as { id: string };
	known[kind] = created.id;
	await mkdir(root, { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(known), { mode: 0o600 });
	await rename(temporary, file);
	return created.id;
}

async function browser(
	argv: string[],
	request: (method: HelperMethod, input?: unknown) => Promise<any>,
	io: CliIo,
	sleep: (ms: number) => Promise<void>,
) {
	const option = (name: string) => {
		const index = argv.indexOf(name);
		return index < 0 ? undefined : argv[index + 1];
	};
	const [command, action = "list", id] = argv;
	if (command === "approvals" || action === "status" || action === "list") {
		if (action === "open") {
			if (!id) throw new Error("Usage: approvals open <request-id>");
			const { url } = (await request("browser.page", { requestId: id })) as { url: string };
			io.openUrl?.(url);
			return { url, instructions: "Review and approve the browser connection on this page." };
		}
		if (action === "cancel") {
			if (!id) throw new Error("Usage: approvals cancel <request-id>");
			return request("browser.cancel", { requestId: id });
		}
		return request("browser.list");
	}
	switch (action) {
		case "catalog":
			return request("catalog.list");
		case "setup":
		case "install": {
			if (!id) throw new Error("Usage: browser setup <catalog-id> [--workspace <url>]");
			const workspace = option("--workspace");
			const result = (await request("catalog.install", {
				catalogId: id,
				configuration: workspace ? { workspace } : {},
			})) as { requestId?: string };
			if (!result?.requestId) return result;
			io.print(result);
			// Browser approvals may need the headless page when no Desktop window is open.
			const deadline = Date.now() + 600_000;
			while (Date.now() < deadline) {
				await sleep(1000);
				const pending = (await request("browser.list")) as Array<{
					requestId: string;
					state: string;
				}>;
				const current = pending.find((item) => item.requestId === result.requestId);
				if (!current || ["approved", "cancelled", "expired", "error"].includes(current.state))
					return current ?? { state: "ended" };
			}
			return { state: "pending", requestId: result.requestId };
		}
		case "authenticate":
			if (!id) throw new Error("Usage: browser authenticate <connection-id>");
			return request("catalog.authenticate", { id });
		case "disconnect":
		case "uninstall":
			if (!id) throw new Error(`Usage: browser ${action} <connection-id>`);
			return request("server.remove", { id });
		case "migrate":
		case "rollback":
			throw new Error(
				"Browser migrations are handled by Laplace Runtime. Use import-legacy for CLI connectors, then browser setup.",
			);
		default:
			throw new Error("Use browser catalog|setup|authenticate|status|disconnect");
	}
}

async function updates(
	argv: string[],
	root: string,
	request: (method: HelperMethod, input?: unknown) => Promise<any>,
) {
	const [, action, id] = argv;
	switch (action) {
		case "status":
			return {
				policy: await new UpdatePolicyStore().read(),
				automaticEnabled: automaticUpdatesEnabled(),
				inactivity: await computerIdleSeconds().then((seconds) =>
					seconds === undefined
						? "Computer inactivity is unavailable; automatic installation is deferred."
						: { seconds, requiredSeconds: 900 },
				),
				connectors: await request("updates.connectors"),
			};
		case "check":
			return request("updates.checkConnectors");
		case "pin":
		case "unpin":
			if (!id || id.startsWith("--")) throw new Error("Provide a connection ID to pin or unpin.");
			await new UpdatePolicyStore().mutate((value) => {
				value.pins[updateInstanceKey(root, id)] = action === "pin";
			});
			return request("updates.pin", { id, pinned: action === "pin" });
		case "apply": {
			const rows = (await request("updates.connectors")) as Array<{
				id: string;
				availableVersion?: string;
			}>;
			for (const row of rows)
				if ((!id || row.id === id) && row.availableVersion)
					await request("updates.applyConnector", { id: row.id });
			return request("updates.connectors");
		}
		case "enroll":
			if (!id) throw new Error("Use updates enroll <connection-id>");
			return request("updates.enroll", { id });
		default:
			throw new Error(
				"Use updates status|check|enable|disable|pin <id>|unpin <id>|apply [id]|defer|enroll <id>",
			);
	}
}
