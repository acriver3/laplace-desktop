import { useState } from "react";

/** Dismissing a receipt hides presentation only; it never cancels or deletes work. */
export function useDismissedSetup(key: string) {
	const [dismissed, setDismissed] = useState<string[]>(() => {
		try {
			const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
			return Array.isArray(value)
				? value.filter((id): id is string => typeof id === "string").slice(-200)
				: [];
		} catch {
			return [];
		}
	});
	return {
		hidden: (id: string, status: string) => dismissed.includes(`${id}:${status}`),
		dismiss: (id: string, status: string) =>
			setDismissed((current) => {
				const next = [
					...current.filter((value) => value !== `${id}:${status}`),
					`${id}:${status}`,
				].slice(-200);
				try {
					localStorage.setItem(key, JSON.stringify(next));
				} catch {
					/* Keep this session dismissible. */
				}
				return next;
			}),
	};
}
