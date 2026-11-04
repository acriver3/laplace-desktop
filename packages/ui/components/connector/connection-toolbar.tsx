import type { ReactNode } from "react";

import { Input } from "../input";

export function ConnectionToolbar({
	search,
	searchIcon,
	searchFilter,
	locationFilter,
	onSearch,
	searchLabel,
	filterLabel,
	filters,
	view,
	onView,
	children,
}: {
	search: string;
	searchIcon: ReactNode;
	searchFilter?: ReactNode;
	locationFilter?: ReactNode;
	onSearch: (value: string) => void;
	searchLabel: string;
	filterLabel: string;
	filters: { value: string; label: string }[];
	view: string;
	onView: (value: string) => void;
	children: ReactNode;
}) {
	return (
		<div className="connector-connections-toolbar">
			<div className="connector-provider-search">
				{searchIcon}
				<Input
					id="connector-search"
					type="search"
					aria-label={searchLabel}
					placeholder={searchLabel}
					value={search}
					onChange={(event) => onSearch(event.target.value)}
				/>
				{searchFilter}
			</div>
			<div className="connector-filter-bar">
				<div className="connection-view-filter" role="group" aria-label={filterLabel}>
					{filters.map(({ value, label }) => (
						<button
							key={value}
							type="button"
							aria-pressed={view === value}
							onClick={() => onView(value)}
						>
							{label}
						</button>
					))}
				</div>
				{locationFilter}
			</div>
			<div className="connector-connections-toolbar-actions">{children}</div>
		</div>
	);
}
