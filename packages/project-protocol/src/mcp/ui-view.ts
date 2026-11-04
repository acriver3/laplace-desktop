import { z } from "zod";

import { connectionUrl } from "../connection-links";
import { compareProvidersForDiscovery } from "../provider-discovery";
import {
	homeInput,
	type HomeAccount,
	type HomeCounts,
	type HomeItem,
	type HomeSection,
	type HomeViewResult,
} from "./ui-schema";

const accountsSchema = z.array(
	z.object({
		accountId: z.string(),
		name: z.string(),
		slug: z.string().nullable(),
	}),
);
const providerSchema = z.array(
	z.object({
		service: z.string(),
		displayName: z.string().optional(),
		description: z.string().optional(),
		categories: z.array(z.string()).optional(),
		partialAvailability: z.boolean().optional(),
	}),
);
const connectionsSchema = z.array(
	z.object({
		id: z.string(),
		service: z.string(),
		connectionName: z.string(),
		status: z.string().optional(),
		providerLabel: z.string().optional(),
		partialAvailability: z.boolean().optional(),
		profile: z
			.object({
				displayName: z.string().nullish(),
				email: z.string().nullish(),
				username: z.string().nullish(),
			})
			.nullish(),
	}),
);
const desktopsSchema = z.array(
	z.object({
		id: z.string(),
		name: z.string(),
		online: z.boolean(),
		connections: z.array(
			z.object({
				id: z.string(),
				localId: z.string(),
				name: z.string(),
				enabled: z.boolean(),
				visible: z.boolean().optional(),
				remoteEnabled: z.boolean().optional(),
				health: z.array(z.string()).optional(),
			}),
		),
	}),
);
const cursorSchema = z.object({
	accountId: z.string(),
	section: z.enum(["connected", "available", "local"]),
	query: z.string(),
	after: z.string(),
});
type SearchItem = HomeItem & { search: string };
type Sections = Record<HomeSection, SearchItem[]>;
const countLabel = (count: number) => `${count} connection${count === 1 ? "" : "s"}`;
const publicItem = ({ search: _search, ...item }: SearchItem): HomeItem => item;
const matches = (item: SearchItem, query: string) =>
	item.search.toLowerCase().includes(query.toLowerCase());

/** One authorized, bounded home. No provider or Desktop actions execute while rendering. */
export async function getHomeView(
	env: HomeViewServices,
	credential: string,
	raw: unknown,
): Promise<HomeViewResult> {
	if (env.ENABLE_CHATGPT_UI !== "true") throw new Error("ChatGPT UI is not enabled");
	const input = homeInput.parse(raw);
	const access = { credential, include_context: true };
	const grant = await env.authority(access);
	if (!grant.canUseConnections) throw new Error("Reconnect Laplace with connection access");
	const accounts = accountsSchema.parse(grant.accounts ?? (await env.tool("list_accounts", {})));
	const account = accounts.find((a) => a.accountId === (input.accountId ?? accounts[0]?.accountId));
	if (!account) throw new Error("Select an authorized Laplace account");
	const scope = { accountId: account.accountId };
	const desktopAvailable =
		grant.providerTools?.some((tool) => tool.name === "desktop_connectors_list") ?? true;
	const [providersRead, connectionsRead, desktopsRead] = await Promise.allSettled([
		env
			.tool("list_apps", { ...scope, metadataOnly: true })
			.then((result) => providerSchema.parse(result)),
		env.tool("list_connections", { ...scope, source: "cloud" }).then((result) => {
			// Desktop entries use a different contract and are read via the dedicated list.
			const cloud = z
				.array(z.object({ service: z.string() }).passthrough())
				.parse(result)
				.filter((item) => item.service !== "desktop");
			return connectionsSchema.parse(cloud);
		}),
		desktopAvailable
			? env.tool("desktop_connectors_list", scope).then((result) => desktopsSchema.parse(result))
			: Promise.resolve(null),
	]);
	const providers = providersRead.status === "fulfilled" ? providersRead.value : [];
	const connections = connectionsRead.status === "fulfilled" ? connectionsRead.value : [];
	const desktops = desktopsRead.status === "fulfilled" ? desktopsRead.value : null;
	const url = (selection: Parameters<typeof connectionUrl>[2] = {}) =>
		connectionUrl(env.LAPLACE_CONNECT_URL, account.slug, selection);
	const sections: Sections = { connected: [], available: [], local: [] };
	const groups = new Map<string, typeof connections>();
	for (const connection of connections) {
		const group = groups.get(connection.service) ?? [];
		group.push(connection);
		groups.set(connection.service, group);
	}
	for (const [service, entries] of groups) {
		const provider = providers.find((p) => p.service === service);
		const name = provider?.displayName ?? entries[0].providerLabel ?? service;
		const needsRefresh = entries.some((c) => c.status === "reauth_required");
		sections.connected.push({
			id: `provider:${service}`,
			name,
			service,
			connectionCount: entries.length,
			subtitle: needsRefresh
				? `${countLabel(entries.length)} · Needs refresh`
				: countLabel(entries.length),
			status: needsRefresh ? "needs_refresh" : "connected",
			url: url({ provider: service }),
			search: [
				name,
				service,
				provider?.description,
				...entries.map((c) =>
					[c.connectionName, c.profile?.displayName, c.profile?.email, c.profile?.username].join(
						" ",
					),
				),
			].join(" "),
		});
	}
	sections.connected.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	for (const provider of [...providers].sort((a, b) =>
		compareProvidersForDiscovery(
			{ ...a, displayName: a.displayName ?? a.service },
			{ ...b, displayName: b.displayName ?? b.service },
		),
	)) {
		if (
			groups.has(provider.service) ||
			sections.available.some((p) => p.service === provider.service)
		)
			continue;
		const name = provider.displayName ?? provider.service;
		sections.available.push({
			id: `provider:${provider.service}`,
			service: provider.service,
			name,
			connectionCount: 0,
			subtitle: "Available to connect",
			status: "available",
			url: url({ setup: provider.service }),
			search: [name, provider.service, provider.description, ...(provider.categories ?? [])].join(
				" ",
			),
		});
	}
	for (const desktop of desktops ?? []) {
		for (const connection of desktop.connections.filter((c) => c.visible !== false)) {
			const status = !connection.enabled
				? "disabled"
				: !desktop.online
					? "offline"
					: connection.health?.includes("online")
						? "online"
						: connection.health?.includes("stopped")
							? "offline"
							: "unknown";
			const statusText =
				status === "unknown"
					? connection.health?.includes("needs_attention")
						? "Needs attention"
						: connection.health?.includes("starting")
							? "Starting"
							: "Status unavailable"
					: status[0].toUpperCase() + status.slice(1);
			const name = connection.name;
			sections.local.push({
				id: `local:${connection.id}`,
				service: connection.localId === "ycombinator-demo" ? "ycombinator" : connection.localId,
				name,
				connectionCount: 1,
				status,
				subtitle: `${desktop.name} · ${statusText}`,
				url: url({ installationId: desktop.id, connectionId: connection.id }),
				search: `${name} ${connection.localId} ${desktop.name}`,
			});
		}
		if (!desktop.connections.length)
			sections.local.push({
				id: `desktop:${desktop.id}`,
				service: "laplace-desktop",
				name: desktop.name,
				connectionCount: 0,
				subtitle: "0 Local Connections",
				status: desktop.online ? "online" : "offline",
				url: url({ installationId: desktop.id }),
				search: `${desktop.name} Laplace Desktop`,
			});
	}
	sections.local.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	const counts: HomeCounts = {
		connected: connectionsRead.status === "fulfilled" ? sections.connected.length : null,
		available:
			providersRead.status === "fulfilled" && connectionsRead.status === "fulfilled"
				? sections.available.length
				: null,
		local: desktops === null ? null : sections.local.length,
	};
	const warnings: string[] = [];
	const localError =
		desktops === null
			? desktopAvailable
				? "Local connections could not be loaded."
				: "Local inventory is not available for this connection."
			: null;
	if (input.section === "local") {
		if (localError) warnings.push(localError);
	} else {
		if (
			providers.some((p) => p.partialAvailability) ||
			connections.some((c) => c.partialAvailability)
		)
			warnings.push(
				"Some cloud connections are temporarily unavailable. Counts may be incomplete.",
			);
		if (providersRead.status === "rejected")
			warnings.push("The connector catalog could not be loaded.");
		if (connectionsRead.status === "rejected")
			warnings.push("Saved connections could not be loaded.");
	}
	const unavailable = counts[input.section] === null;
	const error = unavailable
		? input.section === "local"
			? localError
			: "This section could not be loaded. Refresh to try again."
		: null;

	const presentation: Sections = {
		connected: [...sections.connected],
		available: [...sections.available],
		local: [...sections.local],
	};
	const demoItemIds: string[] = [];
	const demoAccounts = (env.MCP_HOME_YC_DEMO_ACCOUNT_IDS ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	if (counts.connected !== null && demoAccounts.includes(account.accountId)) {
		const real = [...sections.connected, ...sections.local].find(
			(item) => item.service === "ycombinator",
		);
		const demo: SearchItem = real ?? {
			id: "demo:ycombinator",
			name: "Y Combinator",
			service: "ycombinator",
			subtitle: "Connected",
			status: "connected",
			connectionCount: 0,
			url: url({ demo: true }),
			search: "Y Combinator YC application demo",
		};
		for (const key of ["connected", "available", "local"] as const)
			presentation[key] = presentation[key].filter((item) => item.service !== "ycombinator");
		presentation.connected.unshift(demo);
		if (!real) demoItemIds.push(demo.id);
	}
	const displayCounts = Object.fromEntries(
		(["connected", "available", "local"] as const).map((section) => [
			section,
			counts[section] === null ? null : presentation[section].length,
		]),
	) as HomeCounts;
	const selected = unavailable
		? []
		: presentation[input.section].filter((item) => matches(item, input.query));
	let offset = 0;
	if (input.cursor) {
		let cursor: z.infer<typeof cursorSchema>;
		try {
			cursor = cursorSchema.parse(JSON.parse(decodeURIComponent(input.cursor)));
		} catch {
			throw new Error("Invalid page. Start from the first page.");
		}
		if (
			cursor.accountId !== account.accountId ||
			cursor.section !== input.section ||
			cursor.query !== input.query
		)
			throw new Error("The selection changed. Start from the first page.");
		offset = selected.findIndex((item) => item.id === cursor.after) + 1;
		if (!offset) throw new Error("The connection list changed. Start from the first page.");
	}
	const page = selected.slice(offset, offset + input.limit);
	const next =
		offset + input.limit < selected.length && page.length
			? encodeURIComponent(
					JSON.stringify({
						...scope,
						section: input.section,
						query: input.query,
						after: page[page.length - 1]!.id,
					}),
				)
			: null;
	// Revalidate after every source read so revoked or removed accounts cannot leak a late result.
	const current = await env.authority(access);
	if (!current.canUseConnections) throw new Error("Reconnect Laplace with connection access");
	const currentAccounts = accountsSchema.parse(
		current.accounts ?? (await env.tool("list_accounts", {})),
	);
	if (!currentAccounts.some((item) => item.accountId === account.accountId))
		throw new Error("Account access is no longer available");
	const realItems = sections[input.section].filter((item) => matches(item, input.query));
	const realById = new Map(realItems.map((item) => [item.id, item]));
	return {
		structuredContent: {
			view: "home",
			account,
			accounts: currentAccounts,
			section: input.section,
			query: input.query,
			cursor: input.cursor,
			limit: input.limit,
			items: page.flatMap((item) => {
				const real = realById.get(item.id);
				return real ? [publicItem(real)] : [];
			}),
			counts,
			total: unavailable ? 0 : realItems.length,
			next_cursor: next,
			warnings,
			error,
			links: { home: url(), connections: url() },
		},
		_meta: {
			presentation: {
				items: page.map(publicItem),
				counts: displayCounts,
				total: selected.length,
				demoItemIds,
			},
		},
	};
}

export interface HomeViewServices {
	ENABLE_CHATGPT_UI?: string;
	MCP_HOME_YC_DEMO_ACCOUNT_IDS?: string;
	LAPLACE_CONNECT_URL: string;
	authority(input: { credential: string; include_context?: boolean }): Promise<{
		canUseConnections?: boolean;
		accounts?: HomeAccount[];
		providerTools?: { name: string }[];
	}>;
	tool(name: string, input: Record<string, unknown>): Promise<unknown>;
}
