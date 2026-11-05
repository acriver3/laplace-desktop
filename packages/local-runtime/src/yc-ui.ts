import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { scopedToolName } from "@repo/project-protocol/local-mcp";
import {
	ycViewInput,
	ycRenderInput,
	ycPreviewInput,
	ycSaveInput,
	ycSnapshotSchema,
	ycChangeSchema,
	type YcView,
} from "@repo/project-protocol/mcp/yc-schema";
import { z } from "zod";

import type { DesktopManager } from "./manager";
import { ycBrowserIdentity } from "./shared/yc-browser";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
// The 0.1.5 Windows demo installer copied this exact bundled adapter outside the app.
// Recognize its code after an app upgrade without changing the saved launch configuration.
const previousBundledYcAdapters = new Set([
	"1134c2a605564a29fa10452765e50565f3e258b15673c20c79a69fb6dba5fb4f",
]);
type Manager = Pick<
	DesktopManager,
	"listServers" | "getServerConfig" | "tools" | "call" | "client"
>;
/** Recognize legacy custom installs only when they run the exact Desktop-shipped adapter. */
export function isBundledYcAdapter(
	config: ReturnType<Manager["getServerConfig"]>,
	bundled = join(dirname(process.argv[1]), "yc-browser.cjs"),
) {
	if (config.identity === ycBrowserIdentity) return true;
	if (
		config.transport !== "stdio" ||
		resolve(config.command) !== resolve(process.execPath) ||
		config.args.length !== 1 ||
		!isAbsolute(config.args[0])
	)
		return false;
	try {
		const size = statSync(config.args[0]).size;
		if (size > 8 * 1024 * 1024) return false;
		const code = readFileSync(config.args[0]);
		if (previousBundledYcAdapters.has(createHash("sha256").update(code).digest("hex"))) return true;
		return size === statSync(bundled).size && code.equals(readFileSync(bundled));
	} catch {
		return false;
	}
}
export function ycConnections(manager: Manager, clientId: string) {
	manager.client(clientId);
	const allowed = new Set(manager.tools(clientId).map((tool) => tool.name));
	return manager
		.listServers()
		.filter(
			(server) =>
				isBundledYcAdapter(manager.getServerConfig(server.id)) &&
				["list_applications", "read_application"].every((tool) =>
					allowed.has(scopedToolName(server.id, tool, digest)),
				),
		);
}
/** Capture underlying grants so revocation also cancels an in-flight editor save. */
export function ycInvocationTools(
	manager: Manager,
	clientId: string,
	input: Record<string, unknown>,
) {
	const connections = ycConnections(manager, clientId);
	const selected = input.connectionName
		? connections.find((connection) => connection.id === input.connectionName)
		: connections.length === 1
			? connections[0]
			: undefined;
	if (!selected) return [];
	return [
		"list_applications",
		"read_application",
		...(input.changes || input.proposedChanges ? ["save_draft"] : []),
	].map((tool) => scopedToolName(selected.id, tool, digest));
}
export async function desktopYcView(
	manager: Manager,
	clientId: string,
	name: string,
	raw: Record<string, unknown>,
	signal: AbortSignal,
): Promise<YcView> {
	const input = (
		name === "save_yc_draft"
			? ycSaveInput
			: name === "preview_yc_draft"
				? ycPreviewInput
				: name === "render_yc_application"
					? ycRenderInput
					: ycViewInput
	).parse(raw);
	if (input.accountId && input.accountId !== "desktop") throw Error("Unknown Desktop account.");
	const servers = ycConnections(manager, clientId);
	const selected = input.connectionName
		? servers.find((server) => server.id === input.connectionName)
		: servers.length === 1
			? servers[0]
			: undefined;
	if (input.connectionName && !selected)
		throw Error("YC connection is unavailable for this client.");
	const view: YcView = {
		kind: "yc_application",
		state: "connections",
		accountId: "desktop",
		accounts: [{ accountId: "desktop", name: "This Desktop" }],
		connections: servers.map((server) => ({
			connectionName: server.id,
			name: server.name,
			status: "active",
		})),
		applications: [],
		connectionsUrl: "https://apply.ycombinator.com/",
	};
	if (!selected) return view;
	view.connectionName = selected.id;
	const call = async (tool: string, args: Record<string, unknown>) => {
		const result = CallToolResultSchema.parse(
			await manager.call(selected.id, tool, args, signal, clientId),
		);
		const text = result.content.find((item) => item.type === "text");
		let data: unknown;
		try {
			data = result.structuredContent ?? JSON.parse(text?.type === "text" ? text.text : "null");
		} catch {
			throw Error(
				result.isError && text?.type === "text"
					? text.text.slice(0, 600)
					: "YC returned an unreadable result. Refresh before saving.",
			);
		}
		const error = z
			.object({ error: z.object({ code: z.string(), message: z.string() }) })
			.safeParse(data);
		if (error.success) throw Error(`${error.data.error.code}: ${error.data.error.message}`);
		if (result.isError)
			throw Error("YC operation failed. Check your approved browser tab before retrying.");
		return data;
	};
	if (!input.applicationId) {
		view.applications = z
			.object({
				applications: z.array(
					z.object({ applicationId: z.string().uuid(), title: z.string(), url: z.string().url() }),
				),
			})
			.parse(await call("list_applications", {}))
			.applications.map((item) => ({
				...item,
				url: `https://apply.ycombinator.com/apps/${item.applicationId}/edit`,
			}));
		view.state = "applications";
		return view;
	}
	const changes =
		"changes" in input
			? input.changes
			: "proposedChanges" in input
				? input.proposedChanges
				: undefined;
	const saving = name === "save_yc_draft";
	const result = changes
		? await call("save_draft", {
				applicationId: input.applicationId,
				changes,
				expectedRevision: "expectedRevision" in input ? input.expectedRevision : undefined,
				confirm: saving,
			})
		: await call("read_application", { applicationId: input.applicationId });
	const snapshot = ycSnapshotSchema.parse(result);
	if (snapshot.applicationId !== input.applicationId)
		throw Error("YC returned a different application. Refresh the approved tab.");
	view.application = {
		...snapshot,
		url: `https://apply.ycombinator.com/apps/${snapshot.applicationId}/edit`,
	};
	view.state = "application";
	view.field = "field" in input ? input.field : undefined;
	if (changes && !saving)
		view.changes = z
			.object({ preview: z.literal(true), changes: z.array(ycChangeSchema) })
			.parse(result).changes;
	if (saving) view.saved = z.object({ saved: z.literal(true) }).parse(result).saved;
	return view;
}
