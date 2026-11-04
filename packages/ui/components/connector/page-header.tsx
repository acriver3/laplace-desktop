import type { ReactNode } from "react";

export function ConnectorPageHeader({
	title,
	description,
	actions,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<header className="connector-page-header gap-4 flex flex-wrap items-start justify-between">
			<div className="min-w-0 basis-64 flex-1">
				<h1 className="break-words">{title}</h1>
				{description && <p>{description}</p>}
			</div>
			{actions && <div className="gap-2 flex flex-wrap items-center">{actions}</div>}
		</header>
	);
}
