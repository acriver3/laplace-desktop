import { z } from "zod";

export const homeSections = ["connected", "available", "local"] as const;
export const homeInput = z
	.object({
		accountId: z.string().min(1).max(200).optional(),
		section: z.enum(homeSections).default("connected"),
		query: z.string().trim().max(200).default(""),
		cursor: z.string().max(2000).optional(),
		limit: z.number().int().min(1).max(12).default(12),
	})
	.strict();
export type HomeInput = z.infer<typeof homeInput>;
export type HomeSection = HomeInput["section"];
export type HomeCounts = Record<HomeSection, number | null>;
export interface HomeAccount {
	accountId: string;
	name: string;
	slug: string | null;
}
export interface HomeItem {
	id: string;
	name: string;
	service: string;
	subtitle: string;
	status:
		| "connected"
		| "available"
		| "needs_refresh"
		| "online"
		| "offline"
		| "disabled"
		| "unknown";
	connectionCount: number;
	logoUrl?: string;
	url: string;
}
export interface HomeView {
	view: "home";
	account: HomeAccount;
	accounts: HomeAccount[];
	section: HomeSection;
	query: string;
	cursor?: string;
	limit: number;
	items: HomeItem[];
	counts: HomeCounts;
	total: number;
	next_cursor: string | null;
	warnings: string[];
	error: string | null;
	links: { home: string; connections: string };
}
/** Demo overrides belong to the widget, never to the real connection inventory. */
export interface HomeViewResult {
	structuredContent: HomeView;
	_meta: {
		presentation: { items: HomeItem[]; counts: HomeCounts; total: number; demoItemIds: string[] };
	};
}
