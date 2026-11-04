"use client";

import { Button } from "@repo/ui/components/button";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";

interface UpdatePresentation {
	onUpdateChange?: (listener: (available: boolean) => void) => () => void;
	showUpdates?: () => Promise<void>;
}
const bridge = () => (window as unknown as { laplaceShell?: UpdatePresentation }).laplaceShell;

/** Older clients and ordinary browsers do not expose update presentation. */
export function DesktopUpdateButton() {
	const [available, setAvailable] = useState(false);
	const [error, setError] = useState(false);
	useEffect(() => bridge()?.onUpdateChange?.(setAvailable), []);
	if (!available) return null;
	return (
		<div className="p-2 md:px-4 pb-3">
			<Button
				variant="outline"
				title="Update available"
				aria-label="Update available"
				className="gap-2 md:justify-start w-full justify-center text-primary"
				onClick={() => {
					setError(false);
					void bridge()
						?.showUpdates?.()
						.catch(() => setError(true));
				}}
			>
				<Download className="size-4 shrink-0" aria-hidden="true" />
				<span className="connector-main-label">Update available</span>
			</Button>
			{error && (
				<p role="alert" className="text-xs mt-2">
					Couldn’t open updates. Please try again.
				</p>
			)}
		</div>
	);
}
