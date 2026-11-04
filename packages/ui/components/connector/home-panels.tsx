import type { ReactNode } from "react";

export function HomeStartPanel({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<section
			className="connector-surface home-start-panel space-y-4 p-4 sm:p-6"
			aria-labelledby="home-start"
		>
			<h2 id="home-start" className="connector-section-heading">
				{title}
			</h2>
			<p className="text-sm text-muted-foreground">{description}</p>
			<ol className="home-setup-grid gap-4 grid">{children}</ol>
		</section>
	);
}

export function HomeSummaryPanel({
	title,
	icon,
	children,
}: {
	title: string;
	icon: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="connector-surface home-summary-panel" aria-label={title}>
			<div className="home-panel-heading">
				{icon}
				<h2 className="connector-section-heading">{title}</h2>
			</div>
			{children}
		</section>
	);
}
