import { describe, expect, it, vi } from "vitest";

import { homeUiTools, homeUiResource, HOME_UI_URI } from "./ui-resource";
import { homeInput } from "./ui-schema";
import { getHomeView, type HomeViewServices } from "./ui-view";

const pop = { accountId: "pop", name: "Pop Thrills", slug: "pop-thrills" };
const other = { accountId: "other", name: "Other", slug: "other" };
const uuid = (n: number) => "10000000-0000-4000-8000-" + String(n).padStart(12, "0");
const connection = (service: string, id = service) => ({
	id,
	service,
	connectionName: id,
	status: "active",
});
function fixture() {
	const sources: Record<string, unknown> = {
		list_apps: [
			{ service: "github", displayName: "GitHub" },
			{ service: "notion", displayName: "Notion" },
			{ service: "slack", displayName: "Slack" },
		],
		list_connections: [connection("github", "work"), connection("github", "personal")],
		desktop_connectors_list: [],
	};
	const authority = vi.fn().mockResolvedValue({
		canUseConnections: true,
		accounts: [pop, other],
		providerTools: [{ name: "desktop_connectors_list" }],
	});
	const tool = vi.fn(async (name: string, _input: Record<string, unknown>) => {
		if (sources[name] instanceof Error) throw sources[name];
		return sources[name];
	});
	const env: HomeViewServices = {
		ENABLE_CHATGPT_UI: "true",
		LAPLACE_CONNECT_URL: "https://connect.example",
		authority,
		tool,
	};
	return { env, authority, tool, sources };
}

it("exposes only one read-only general UI tool and the versioned Home resource", () => {
	expect(homeUiTools.map((t) => t.name)).toEqual(["show_home"]);
	expect(homeUiTools[0]).toMatchObject({
		annotations: { readOnlyHint: true, destructiveHint: false },
		_meta: { ui: { visibility: ["model", "app"], resourceUri: HOME_UI_URI } },
	});
	const resource = homeUiResource("https://connect.example/path");
	expect(resource.uri).toBe("ui://laplace/home-v1.html");
	expect(resource._meta.ui.csp).toEqual({
		connectDomains: [],
		resourceDomains: ["https://connect.example"],
	});
	expect(resource.text).toContain("https://connect.example/fonts/inter-variable.woff2");
	expect(resource.text).not.toContain("__LAPLACE_CONNECT_ORIGIN__");
	for (const input of [
		{ view: "apps" },
		{ limit: 13 },
		{ limit: 0 },
		{ query: "x".repeat(201) },
		{ section: "capabilities" },
	])
		expect(homeInput.safeParse(input).success).toBe(false);
});

it("groups authorized saved connections, counts providers, and reads only without management access", async () => {
	const f = fixture();
	f.sources.list_connections = [
		connection("github", "work"),
		{ ...connection("github", "personal"), status: "reauth_required" },
	];
	const { structuredContent: home } = await getHomeView(f.env, "credential", {});
	expect(home.section).toBe("connected");
	expect(home.items).toMatchObject([
		{ service: "github", name: "GitHub", connectionCount: 2, status: "needs_refresh" },
	]);
	expect(home.counts).toEqual({ connected: 1, available: 2, local: 0 });
	expect(new URL(home.items[0].url).searchParams.get("provider")).toBe("github");
	expect(f.tool.mock.calls).toEqual([
		["list_apps", { accountId: "pop", metadataOnly: true }],
		["list_connections", { accountId: "pop", source: "cloud" }],
		["desktop_connectors_list", { accountId: "pop" }],
	]);
	expect(f.authority).toHaveBeenCalledTimes(2);
});

it("rejects unauthorized account selection before reading sources and isolates authorized accounts", async () => {
	const f = fixture();
	await expect(getHomeView(f.env, "c", { accountId: "foreign" })).rejects.toThrow("authorized");
	expect(f.tool).not.toHaveBeenCalled();
	await getHomeView(f.env, "c", { accountId: "other" });
	expect(f.tool.mock.calls.every(([, input]) => input.accountId === "other")).toBe(true);
});

it("denies disabled UI, missing scope, expired access, and access removed during a read", async () => {
	const f = fixture();
	await expect(getHomeView({ ...f.env, ENABLE_CHATGPT_UI: "false" }, "c", {})).rejects.toThrow(
		"not enabled",
	);
	f.authority.mockResolvedValueOnce({ canUseConnections: false });
	await expect(getHomeView(f.env, "c", {})).rejects.toThrow("connection access");
	f.authority.mockRejectedValueOnce(new Error("Access expired"));
	await expect(getHomeView(f.env, "c", {})).rejects.toThrow("expired");
	f.authority
		.mockResolvedValueOnce({ canUseConnections: true, accounts: [pop] })
		.mockResolvedValueOnce({ canUseConnections: true, accounts: [other] });
	await expect(getHomeView(f.env, "c", {})).rejects.toThrow("no longer");
});

it("filters catalog providers by authorized saved connections and preserves browser discovery order", async () => {
	const f = fixture();
	f.sources.list_apps = [
		{ service: "zz", displayName: "A custom connector" },
		{ service: "github", displayName: "GitHub" },
		{ service: "gmail", displayName: "Gmail" },
		{ service: "fusion-api", displayName: "Fusion" },
		{ service: "googlesheets", displayName: "Google Sheets" },
	];
	const result = await getHomeView(f.env, "c", { section: "available" });
	expect(result.structuredContent.items.map((i) => i.service)).toEqual([
		"fusion-api",
		"googlesheets",
		"gmail",
		"zz",
	]);
	expect(
		result.structuredContent.items.every(
			(i) => new URL(i.url).searchParams.get("setup") === i.service,
		),
	).toBe(true);
	expect(
		(await getHomeView(f.env, "c", { section: "available", query: "Github" })).structuredContent
			.items,
	).toEqual([]);
	expect(
		(await getHomeView(f.env, "c", { query: "PERSONAL" })).structuredContent.items,
	).toHaveLength(1);
});

it("bounds selected-section pages, avoids duplicates, and binds cursors to account, section and search", async () => {
	const f = fixture();
	f.sources.list_apps = Array.from({ length: 30 }, (_, i) => ({
		service: "provider-" + i,
		displayName: "Provider " + String(i).padStart(2, "0"),
	}));
	const first = await getHomeView(f.env, "c", { section: "available" });
	expect(first.structuredContent.items).toHaveLength(12);
	expect(first.structuredContent).not.toHaveProperty("connections");
	const cursor = first.structuredContent.next_cursor!;
	const second = await getHomeView(f.env, "c", { section: "available", cursor });
	expect(
		new Set([...first.structuredContent.items, ...second.structuredContent.items].map((i) => i.id))
			.size,
	).toBe(24);
	for (const changed of [{ accountId: "other" }, { section: "local" }, { query: "changed" }])
		await expect(
			getHomeView(f.env, "c", { section: "available", cursor, ...changed }),
		).rejects.toThrow("selection changed");
	await expect(getHomeView(f.env, "c", { cursor: "%invalid" })).rejects.toThrow("Invalid page");
	expect(
		(await getHomeView(f.env, "c", { section: "available", limit: 6 })).structuredContent.items,
	).toHaveLength(6);
});

it("shows only visible Local connectors with device names and observed status, never assuming an online device means an online connector", async () => {
	const f = fixture();
	const local = (id: number, enabled: boolean, health: string[], visible = true) => ({
		id: uuid(id),
		localId: "local-" + id,
		name: "Connector " + id,
		enabled,
		health,
		visible,
	});
	f.sources.desktop_connectors_list = [
		{
			id: uuid(10),
			name: "Work laptop",
			online: true,
			connections: [
				local(1, true, ["online"]),
				local(2, false, ["online"]),
				local(3, true, ["stopped"]),
				local(4, true, []),
				local(5, true, ["online"], false),
			],
		},
		{
			id: uuid(20),
			name: "Home desktop",
			online: false,
			connections: [local(6, true, ["online"])],
		},
	];
	const home = (await getHomeView(f.env, "c", { section: "local" })).structuredContent;
	expect(home.items.map((i) => i.status)).toEqual([
		"online",
		"disabled",
		"offline",
		"unknown",
		"offline",
	]);
	expect(home.items[0].subtitle).toBe("Work laptop · Online");
	expect(home.items[0].url).toContain("localConnection=" + uuid(1));
	expect(home.items).toHaveLength(5);
	expect(JSON.stringify(home)).not.toContain("Connector 5");
});

describe("partial failures", () => {
	it("keeps cloud browsing available when Local is unavailable", async () => {
		const f = fixture();
		f.sources.desktop_connectors_list = new Error("private backend failure");
		const connected = (await getHomeView(f.env, "c", {})).structuredContent;
		expect(connected.items).toHaveLength(1);
		expect(connected.counts.local).toBeNull();
		expect(connected.error).toBeNull();
		expect(connected.warnings).toEqual([]);
		expect(
			(await getHomeView(f.env, "c", { section: "available" })).structuredContent.items,
		).toHaveLength(2);
		const local = (await getHomeView(f.env, "c", { section: "local" })).structuredContent;
		expect(local.error).toContain("Local");
		expect(local.items).toEqual([]);
		expect(JSON.stringify(local)).not.toContain("private backend failure");
	});
	it("does not classify an unknown cloud inventory as available or block Local", async () => {
		const f = fixture();
		f.sources.list_connections = new Error("offline");
		const home = (await getHomeView(f.env, "c", { section: "available" })).structuredContent;
		expect(home.items).toEqual([]);
		expect(home.counts.available).toBeNull();
		expect(home.error).toBeTruthy();
		const local = (await getHomeView(f.env, "c", { section: "local" })).structuredContent;
		expect(local.error).toBeNull();
		expect(local.warnings).toEqual([]);
	});
	it("keeps connected names without the catalog and reports partial inventory", async () => {
		const f = fixture();
		f.sources.list_apps = new Error("catalog");
		f.sources.list_connections = [{ ...connection("github"), partialAvailability: true }];
		const home = (await getHomeView(f.env, "c", {})).structuredContent;
		expect(home.items[0].service).toBe("github");
		expect(home.warnings.join(" ")).toContain("incomplete");
	});
	it("does not call an unadvertised Desktop source", async () => {
		const f = fixture();
		f.authority.mockResolvedValue({ canUseConnections: true, accounts: [pop], providerTools: [] });
		expect((await getHomeView(f.env, "c", { section: "local" })).structuredContent.error).toContain(
			"not available",
		);
		expect(f.tool.mock.calls.map(([name]) => name)).not.toContain("desktop_connectors_list");
	});
});

describe("Pop Thrills presentation", () => {
	it("places YC first only for an allowlisted account and never adds it to real connection inventory", async () => {
		const f = fixture();
		f.env.MCP_HOME_YC_DEMO_ACCOUNT_IDS = "pop";
		const home = await getHomeView(f.env, "c", {});
		expect(home._meta.presentation.items[0]).toMatchObject({
			id: "demo:ycombinator",
			status: "connected",
			connectionCount: 0,
		});
		expect(home._meta.presentation.demoItemIds).toEqual(["demo:ycombinator"]);
		expect(home.structuredContent.items.map((i) => i.service)).toEqual(["github"]);
		expect(home.structuredContent.counts.connected).toBe(1);
		expect(home._meta.presentation.counts.connected).toBe(2);
		const untouched = await getHomeView(f.env, "c", { accountId: "other" });
		expect(untouched._meta.presentation.demoItemIds).toEqual([]);
		expect(untouched._meta.presentation.items.map((i) => i.service)).toEqual(["github"]);
	});
	it("preserves a real YC refresh state and avoids duplicate artwork", async () => {
		const f = fixture();
		f.env.MCP_HOME_YC_DEMO_ACCOUNT_IDS = "pop";
		f.sources.list_connections = [
			connection("github"),
			{ ...connection("ycombinator"), status: "reauth_required" },
		];
		const home = await getHomeView(f.env, "c", {});
		expect(home._meta.presentation.items[0]).toMatchObject({
			service: "ycombinator",
			status: "needs_refresh",
		});
		expect(home._meta.presentation.items.filter((i) => i.service === "ycombinator")).toHaveLength(
			1,
		);
		expect(home._meta.presentation.demoItemIds).toEqual([]);
	});
	it("keeps demo counts consistent while Local fails and paginates the presentation", async () => {
		const f = fixture();
		f.env.MCP_HOME_YC_DEMO_ACCOUNT_IDS = "pop";
		f.sources.desktop_connectors_list = new Error("offline");
		const local = await getHomeView(f.env, "c", { section: "local" });
		expect(local._meta.presentation.counts.connected).toBe(2);
		const first = await getHomeView(f.env, "c", { limit: 1 });
		expect(first.structuredContent.items).toEqual([]);
		const next = await getHomeView(f.env, "c", {
			limit: 1,
			cursor: first.structuredContent.next_cursor!,
		});
		expect(next.structuredContent.items.map((i) => i.service)).toEqual(["github"]);
		expect(next.structuredContent.next_cursor).toBeNull();
	});
});
