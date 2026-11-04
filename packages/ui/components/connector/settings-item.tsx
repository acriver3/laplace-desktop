import type { PropsWithChildren, ReactNode } from "react";

import { cn } from "../../lib";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../card";

export function SettingsItem({
	children,
	title,
	description,
	danger,
}: PropsWithChildren<{
	title: string | ReactNode;
	description?: string | ReactNode;
	danger?: boolean;
}>) {
	return (
		<Card
			data-danger={danger || undefined}
			className="settings-item @2xl:grid @2xl:grid-cols-[min(100%/3,360px)_auto] @2xl:gap-8 @container"
		>
			<CardHeader className="settings-item-header">
				<CardTitle className={cn("font-medium text-base", danger && "text-destructive")}>
					{title}
				</CardTitle>
				{description && (
					<CardDescription className="settings-item-description leading-snug text-muted-foreground">
						{description}
					</CardDescription>
				)}
			</CardHeader>
			<CardContent className="settings-item-content @2xl:pt-6">{children}</CardContent>
		</Card>
	);
}
