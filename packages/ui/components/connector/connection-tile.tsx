import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib";

/** The connection row used by both browser inventory and desktop local inventory. */
export function ConnectionTile({
	title,
	subtitle,
	statusLabel,
	connected = false,
	needsRefresh = false,
	refreshLabel,
	icon,
	onDetails,
	href,
	onNavigate,
	density = "default",
	children,
	className,
	...props
}: HTMLAttributes<HTMLLIElement> & {
	title: string;
	subtitle?: string;
	statusLabel: string;
	connected?: boolean;
	needsRefresh?: boolean;
	refreshLabel?: string;
	icon: ReactNode;
	onDetails?: () => void;
	href?: string;
	onNavigate?: (url: string) => void;
	density?: "default" | "compact";
}) {
	return (
		<li
			data-density={density}
			className={cn(
				"connector-row relative",
				connected && "connector-row-connected",
				needsRefresh && "connector-row-needs-refresh",
				className,
			)}
			{...props}
		>
			<span className="sr-only">{statusLabel}</span>
			{href ? (
				<a
					href={href}
					className="connector-row-target"
					aria-label={`Open ${title} in Laplace`}
					onClick={
						onNavigate
							? (event) => {
									event.preventDefault();
									onNavigate(href);
								}
							: undefined
					}
				>
					<span className="sr-only">Open {title} in Laplace</span>
				</a>
			) : (
				onDetails && (
					<button
						type="button"
						onClick={onDetails}
						aria-label={`Details for ${title}`}
						aria-haspopup="dialog"
						className="connector-row-target"
					>
						<span className="sr-only">Details for {title}</span>
					</button>
				)
			)}
			<>
				{icon}
				<div className="connector-row-content">
					<p className="connector-row-title" title={title}>
						{title}
					</p>
					{needsRefresh && refreshLabel && <p className="text-sm text-warning">{refreshLabel}</p>}
					{subtitle && (
						<p className="connector-row-subtitle" title={subtitle}>
							{subtitle}
						</p>
					)}
				</div>
			</>
			<div className="connector-row-actions relative">{children}</div>
		</li>
	);
}
