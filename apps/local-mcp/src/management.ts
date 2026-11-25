import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PortableOperation } from "@repo/project-protocol/portable-connectors";
import type { CatalogJob } from "@repo/local-runtime/catalog";
import { helperInputs, type HelperMethod } from "@repo/local-runtime/shared/helper-contracts";
import type { CliIo } from "./cli";

type Request = (method: HelperMethod, input?: unknown) => Promise<any>;
export const managementUsage = `
connectors list | show <id> | catalog | fields <id>
connectors install <catalog-id> | install-bundle <file> [--config <json-file>] [--wait]
connectors configure <id> --config <json-file>
connectors authenticate|verify|repair|remove|start|stop|restart <id>
connectors versions <id> | set-version <id> <version|tag>
connectors add-npm <id> <package> [version] [--name <name>] [--bin <command>]
connectors add|preview --config <json-file> | edit <id> --config <json-file>
connectors permissions <id> --tools <comma-separated-names|none>
connectors access <id> --visible true|false --remote true|false
connectors devices | copy <source-id> [--wait]
jobs list | show|wait|retry|cancel <operation-id>
jobs show|wait <catalog-job-id> --catalog
clients list | register <name> | revoke <id>
clients permissions <id> --tools <comma-separated-names|none|all>
clients connect <id> [--desktop-management] | disconnect <id>
runtime info | settings | keep-awake on|off
credentials status
Mutations require terminal confirmation or --confirm. Configuration comes from JSON files.
--idempotency-key <key> makes install/copy/manage retries durable.
--wait waits until setup is ready or needs user action; --timeout <seconds> defaults to 600.
`;

export function option(args: string[], name: string) {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`Provide a value for ${name}`);
	return value;
}
function required(value: string | undefined, message: string): string {
	if (!value || value.startsWith("--")) throw new Error(message);
	return value;
}
async function configuration(args: string[]) {
	const file = required(option(args, "--config"), "Provide --config <json-file>");
	return JSON.parse(await readFile(resolve(file), "utf8"));
}
function tools(args: string[], allowAll = false) {
	const value = required(option(args, "--tools"), "Provide --tools <names|none>");
	if (value === "all" && allowAll) return null;
	return value === "none" ? [] : value.split(",").filter(Boolean);
}
function boolean(args: string[], name: string) {
	const value = option(args, name);
	if (value !== "true" && value !== "false") throw new Error(`Provide ${name} true|false`);
	return value === "true";
}

export class WaitTimeout extends Error {
	constructor(
		readonly receipt: { id: string; status: string },
		catalog: boolean,
	) {
		const command = catalog ? `jobs show ${receipt.id} --catalog` : "jobs show";
		super(`Timed out waiting for operation ${receipt.id}; inspect ${command} before retrying.`);
	}
}

/** Wait for the durable operation, not a browser approval ID. User-action states are returned. */
export async function waitOperation(
	result: PortableOperation,
	args: string[],
	request: Request,
	io: CliIo,
) {
	if (!args.includes("--wait")) return result;
	return waitForJob(
		result,
		args,
		async (id) => {
			const rows = (await request("portable.status", { id })) as PortableOperation[];
			return rows[0];
		},
		io,
	);
}

async function waitForJob<T extends { id: string; status: string; approvalRequestId?: string }>(
	result: T,
	args: string[],
	read: (id: string) => Promise<T | undefined>,
	io: CliIo,
) {
	const seconds = Number(option(args, "--timeout") ?? 600);
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400)
		throw new Error("--timeout must be between 0 and 86400 seconds");
	const deadline = Date.now() + seconds * 1000;
	let current = result;
	while (current.status === "running" && !current.approvalRequestId) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new WaitTimeout(current, args.includes("--catalog"));
		await (io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(Math.min(remaining, 1000));
		const next = await read(current.id);
		if (!next)
			throw new Error(`Operation ${current.id} is unavailable; inspect the connector state.`);
		current = next;
	}
	if (["failed", "cancelled", "interrupted"].includes(current.status)) {
		io.print(current);
		throw new Error(
			`Operation ${current.id}: ${current.status}. Inspect jobs show before retrying.`,
		);
	}
	return current;
}

async function readCatalogJob(request: Request, id: string) {
	const { jobs } = (await request("status")) as { jobs?: CatalogJob[] };
	const job = jobs?.find((job) => job.id === id);
	if (!job) return;
	return {
		id: job.id,
		connectorId: job.serverId,
		kind: job.kind,
		status: job.status,
		stage: job.stage,
		approvalRequestId: job.status === "running" ? job.browserApproval?.requestId : undefined,
	};
}

export async function manage(args: string[], rawRequest: Request, io: CliIo) {
	const [group, action = "list", id, value, version] = args;
	const request: Request = (method, input = {}) =>
		rawRequest(method, helperInputs[method].parse(input));
	const reviewed = async (message: string) =>
		args.includes("--confirm") || (await io.confirm(message));
	const mutate = async (
		method: HelperMethod,
		input: unknown,
		message = `${group} ${action} ${id ?? ""}?`,
	) => {
		const parsed = helperInputs[method].parse(input);
		if (!(await reviewed(message))) return;
		return request(method, parsed);
	};
	const key = () => option(args, "--idempotency-key") ?? randomUUID();
	const connectionId = () => required(id, "Provide a connection ID");
	const operation = async (result: any) =>
		result?.id && result?.status ? waitOperation(result, args, request, io) : result;
	if (group === "connectors") {
		switch (action) {
			case "list":
				return (await request("status")).servers;
			case "show": {
				const server = (await request("status")).servers.find((s: any) => s.id === connectionId());
				if (!server) throw new Error("Unknown connection");
				return server;
			}
			case "catalog":
				return request("catalog.list");
			case "fields":
				return request("portable.fields", { id: connectionId() });
			case "install":
			case "install-bundle":
				return operation(
					await mutate("portable.install", {
						...(action === "install"
							? { catalogId: connectionId() }
							: { bundleFile: resolve(connectionId()) }),
						configuration: option(args, "--config") ? await configuration(args) : {},
						idempotencyKey: key(),
					}),
				);
			case "configure":
				return mutate("portable.manage", {
					idempotencyKey: key(),
					command: {
						action,
						id: connectionId(),
						configuration: await configuration(args),
					},
				});
			case "authenticate":
			case "verify":
			case "repair":
			case "remove":
				return mutate("portable.manage", {
					idempotencyKey: key(),
					command: { action, id: connectionId() },
				});
			case "start":
			case "stop":
			case "restart":
				return mutate(`server.${action}`, { id: connectionId() });
			case "versions":
				return request("npm.versions", { id: connectionId() });
			case "set-version":
				return mutate("npm.setVersion", {
					id: connectionId(),
					version: required(value, "Provide a version or tag"),
				});
			case "add-npm":
				return mutate("npm.add", {
					id: connectionId(),
					name: option(args, "--name") ?? id,
					package: required(value, "Provide an npm package"),
					version: version && !version.startsWith("--") ? version : "latest",
					...(option(args, "--bin") ? { bin: option(args, "--bin") } : {}),
				});
			case "preview":
				return request("server.preview", { config: await configuration(args) });
			case "add":
			case "edit": {
				const config = await configuration(args);
				io.print(
					await request("server.preview", {
						config,
						...(action === "edit" ? { id: connectionId() } : {}),
					}),
				);
				return action === "add"
					? mutate("server.add", { config })
					: mutate("server.update", { id: connectionId(), config });
			}
			case "permissions":
				return mutate("server.permissions", { id: connectionId(), tools: tools(args) });
			case "access":
				return mutate("server.access", {
					id: connectionId(),
					access: {
						visible: boolean(args, "--visible"),
						remoteEnabled: boolean(args, "--remote"),
					},
				});
			case "devices":
				return request("portable.devices");
			case "copy":
				return operation(
					await mutate("portable.copy", { sourceId: connectionId(), idempotencyKey: key() }),
				);
		}
	}
	if (group === "jobs") {
		if (args.includes("--catalog")) {
			if (action !== "show" && action !== "wait")
				throw new Error("--catalog is supported by jobs show and jobs wait");
			const jobId = required(id, "Provide a catalog job ID");
			const read = (id: string) => readCatalogJob(request, id);
			const job = await read(jobId);
			if (!job)
				throw new Error(`Catalog job ${jobId} is unavailable; inspect the connector state.`);
			return action === "show" ? job : waitForJob(job, args, read, io);
		}
		if (action === "list") return request("portable.status");
		const jobId = required(id, "Provide an operation ID");
		if (action === "show") return request("portable.status", { id: jobId });
		if (action === "wait") {
			const rows = await request("portable.status", { id: jobId });
			if (!rows[0]) throw new Error("Unknown operation");
			return waitOperation(rows[0], [...args, "--wait"], request, io);
		}
		if (action === "retry" || action === "cancel")
			return mutate("portable.manage", { idempotencyKey: key(), command: { action, id: jobId } });
	}
	if (group === "clients") {
		if (action === "list") return request("client.list");
		if (action === "register")
			return mutate("client.register", { name: required(id, "Provide a client name") });
		const clientId = required(id, "Provide a client ID");
		if (action === "revoke") return mutate("client.revoke", { clientId });
		if (action === "permissions")
			return mutate("client.permissions", { clientId, tools: tools(args, true) });
		if (action === "connect")
			return mutate("hosted.connect", {
				clientId,
				desktopManagement: args.includes("--desktop-management"),
			});
		if (action === "disconnect") return mutate("hosted.disconnect", { clientId });
	}
	if (group === "runtime") {
		if (action === "info" || action === "settings") return request(`runtime.${action}`);
		if (action === "keep-awake" && (id === "on" || id === "off"))
			return mutate("runtime.configure", { keepAwake: id === "on" });
	}
	if (group === "credentials" && action === "status") return request("credentials.status");
	throw new Error(managementUsage);
}
