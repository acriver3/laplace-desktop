import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";

import logos from "../../../../../apps/connector/modules/provider-logos.json";
import { ConnectionTile } from "../../../../ui/components/connector/connection-tile";
import { providerInitials, providerLogoPath } from "../../connector-artwork";
import {
	homeSections,
	type HomeInput,
	type HomeItem,
	type HomeView,
	type HomeViewResult,
} from "../ui-schema";
import { callTool, openLink, subscribe } from "./bridge";

const labels = { connected: "Connected", available: "Available", local: "Local" };
const pageSize = () => (window.innerWidth < 480 ? 6 : 12);
type Result = { view: HomeView; presentation: HomeViewResult["_meta"]["presentation"] };
function readResult(result: {
	structuredContent?: unknown;
	_meta?: Record<string, unknown>;
}): Result | undefined {
	const view = result.structuredContent as HomeView | undefined;
	if (view?.view !== "home" || !Array.isArray(view.items) || !view.account) return;
	const presentation = result._meta?.presentation as Result["presentation"] | undefined;
	return {
		view,
		presentation: presentation ?? {
			items: view.items,
			counts: view.counts,
			total: view.total,
			demoItemIds: [],
		},
	};
}

function Icon({ type }: { type: "search" | "refresh" | "chevron" | "external" }) {
	const paths = {
		search: (
			<>
				<circle cx="10.5" cy="10.5" r="6.5" />
				<path d="m16 16 4 4" />
			</>
		),
		refresh: (
			<>
				<path d="M20 7v5h-5M4 17v-5h5" />
				<path d="M5.6 7a7 7 0 0 1 11.6-2L20 8M4 16l2.8 3A7 7 0 0 0 18.4 17" />
			</>
		),
		chevron: <path d="m9 6 6 6-6 6" />,
		external: (
			<>
				<path d="M14 3h7v7M21 3l-11 11" />
				<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
			</>
		),
	};
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{paths[type]}
		</svg>
	);
}

function ProviderLogo({ item, origin }: { item: HomeItem; origin: string }) {
	const [failed, setFailed] = useState(false);
	const path = providerLogoPath(item.service, logos.providers);
	return (
		<span className="home-logo" aria-hidden="true">
			{path && !failed ? (
				<img
					src={new URL(path, origin).href}
					width="24"
					height="24"
					alt=""
					onError={() => setFailed(true)}
				/>
			) : (
				providerInitials(item.name)
			)}
		</span>
	);
}

function Home() {
	const initial = useRef<HomeInput>({ section: "connected", query: "", limit: pageSize() });
	const current = useRef(initial.current);
	const [selection, setSelection] = useState(initial.current);
	const [data, setData] = useState<Result>();
	const [search, setSearch] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [history, setHistory] = useState<(string | undefined)[]>([]);
	const sequence = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const received = useRef(false);
	const interacted = useRef(false);

	function accept(result: Result, preserveSearch = false) {
		received.current = true;
		const next = {
			accountId: result.view.account.accountId,
			section: result.view.section,
			query: result.view.query,
			cursor: result.view.cursor,
			limit: result.view.limit,
		};
		current.current = next;
		setSelection(next);
		if (!preserveSearch) setSearch(next.query);
		setData(result);
		setError("");
		setLoading(false);
	}
	function load(next: HomeInput, delay = 0) {
		current.current = next;
		setSelection(next);
		setLoading(true);
		setError("");
		const id = ++sequence.current;
		clearTimeout(timer.current);
		timer.current = setTimeout(async () => {
			try {
				const result = readResult(await callTool("show_home", next));
				if (id !== sequence.current) return;
				if (!result) throw new Error("Laplace returned an unavailable home. Refresh to try again.");
				accept(result, true);
			} catch (reason) {
				if (id !== sequence.current) return;
				setError(
					reason instanceof Error
						? reason.message
						: "Unable to load Laplace. Refresh to try again.",
				);
				setLoading(false);
			}
		}, delay);
	}
	function reset(next: Partial<HomeInput>, delay = 0) {
		interacted.current = true;
		setHistory([]);
		load({ ...current.current, ...next, cursor: undefined }, delay);
	}
	useEffect(() => {
		const unsubscribe = subscribe((raw) => {
			const result = readResult(raw);
			if (!result) return;
			const active = current.current;
			if (
				interacted.current &&
				(result.view.account.accountId !== active.accountId ||
					result.view.section !== active.section ||
					result.view.query !== active.query ||
					result.view.cursor !== active.cursor ||
					result.view.limit !== active.limit)
			)
				return;
			// Initial tool notifications cannot overwrite a newer widget request.
			if (interacted.current) return;
			clearTimeout(timer.current);
			++sequence.current;
			accept(result);
			if (result.view.limit > pageSize()) reset({ limit: pageSize() });
		});
		const fallback = setTimeout(() => {
			if (!received.current && !interacted.current) load(current.current);
		}, 800);
		const resize = () => {
			if (current.current.limit !== pageSize()) reset({ limit: pageSize() });
		};
		window.addEventListener("resize", resize);
		return () => {
			unsubscribe();
			clearTimeout(fallback);
			clearTimeout(timer.current);
			++sequence.current;
			window.removeEventListener("resize", resize);
		};
	}, []);
	function changeTab(event: KeyboardEvent<HTMLButtonElement>) {
		const index = homeSections.indexOf(selection.section);
		const next =
			event.key === "ArrowRight"
				? (index + 1) % 3
				: event.key === "ArrowLeft"
					? (index + 2) % 3
					: event.key === "Home"
						? 0
						: event.key === "End"
							? 2
							: -1;
		if (next < 0) return;
		event.preventDefault();
		reset({ section: homeSections[next] });
		document.getElementById("tab-" + homeSections[next])?.focus();
	}
	async function navigate(url: string) {
		try {
			await openLink(url);
		} catch {
			setError("The browser link could not be opened. Try again.");
		}
	}

	const view = data?.view;
	const display = data?.presentation;
	const validAccount = !selection.accountId || selection.accountId === view?.account.accountId;
	const panelError = error || (!loading ? view?.error : null);
	const empty = selection.query
		? "No connections match your search."
		: selection.section === "connected"
			? "No connected providers yet. Explore Available to get started."
			: selection.section === "local"
				? "No visible Desktop connectors in this account."
				: "Every available provider is already connected.";
	return (
		<main className="home">
			<header className="home-header">
				<strong className="home-brand">Laplace</strong>
				{view && view.accounts.length > 1 ? (
					<select
						aria-label="Laplace account"
						value={selection.accountId}
						onChange={(event) => reset({ accountId: event.target.value })}
					>
						{view.accounts.map((account) => (
							<option key={account.accountId} value={account.accountId}>
								{account.name}
							</option>
						))}
					</select>
				) : (
					<span className="home-account" title={view?.account.name}>
						{view?.account.name ?? "Connections"}
					</span>
				)}
				{view && (
					<a
						className="home-open"
						href={view.links.home}
						onClick={(event) => {
							event.preventDefault();
							void navigate(view.links.home);
						}}
					>
						Open Laplace <Icon type="external" />
					</a>
				)}
			</header>
			<div className="home-tabs" role="tablist" aria-label="Connection sections">
				{homeSections.map((section) => (
					<button
						type="button"
						role="tab"
						key={section}
						id={"tab-" + section}
						aria-controls={"panel-" + selection.section}
						aria-selected={selection.section === section}
						tabIndex={selection.section === section ? 0 : -1}
						onKeyDown={changeTab}
						onClick={() => reset({ section })}
					>
						{labels[section]}
						<span className="home-count">
							{validAccount && display ? (display.counts[section] ?? "—") : "—"}
						</span>
					</button>
				))}
			</div>
			<div className="home-toolbar">
				<label className="home-search">
					<Icon type="search" />
					<span className="sr-only">Search {labels[selection.section].toLowerCase()}</span>
					<input
						type="search"
						value={search}
						placeholder={"Search " + labels[selection.section].toLowerCase() + "…"}
						maxLength={200}
						onChange={(event) => {
							setSearch(event.target.value);
							reset({ query: event.target.value.trim() }, 250);
						}}
					/>
				</label>
				<button
					className="home-refresh"
					type="button"
					aria-label="Refresh connections"
					title="Refresh connections"
					disabled={loading}
					onClick={() => reset({})}
				>
					<Icon type="refresh" />
				</button>
			</div>
			<section
				role="tabpanel"
				id={"panel-" + selection.section}
				aria-labelledby={"tab-" + selection.section}
				aria-busy={loading}
				tabIndex={0}
			>
				{loading ? (
					<>
						<span role="status" className="sr-only">
							Loading {labels[selection.section].toLowerCase()} connections
						</span>
						<ul className="home-grid" aria-hidden="true">
							{Array.from({ length: selection.limit }, (_, i) => (
								<li className="home-skeleton" key={i}>
									<span />
									<span />
								</li>
							))}
						</ul>
					</>
				) : panelError ? (
					<p role="alert" className="home-message">
						{panelError}
					</p>
				) : (
					<>
						{!!view?.warnings.length && (
							<p role="status" className="home-warning">
								{view.warnings.join(" ")}
							</p>
						)}
						{display?.items.length ? (
							<ul className="home-grid">
								{display.items.map((item) => (
									<ConnectionTile
										key={view!.account.accountId + item.id}
										density="compact"
										title={item.name}
										subtitle={item.subtitle}
										statusLabel={
											display.demoItemIds.includes(item.id)
												? "Presentation demo — not an authorized connection"
												: item.status.replaceAll("_", " ")
										}
										connected={item.status === "connected" || item.status === "online"}
										needsRefresh={item.status === "needs_refresh"}
										icon={<ProviderLogo item={item} origin={view!.links.home} />}
										href={item.url}
										onNavigate={(url) => void navigate(url)}
										data-status={item.status}
									>
										<Icon type="chevron" />
									</ConnectionTile>
								))}
							</ul>
						) : (
							<p className="home-message" role="status">
								{empty}
							</p>
						)}
						{view && (history.length > 0 || view.next_cursor) && (
							<nav className="home-pagination" aria-label="Connection pages">
								<button
									type="button"
									disabled={!history.length}
									onClick={() => {
										const previous = history.at(-1);
										setHistory(history.slice(0, -1));
										interacted.current = true;
										load({ ...selection, cursor: previous });
									}}
								>
									Previous
								</button>
								<span>Page {history.length + 1}</span>
								<button
									type="button"
									disabled={!view.next_cursor}
									onClick={() => {
										setHistory([...history, selection.cursor]);
										interacted.current = true;
										load({ ...selection, cursor: view.next_cursor ?? undefined });
									}}
								>
									Next
								</button>
							</nav>
						)}
					</>
				)}
			</section>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<Home />);
