"use client";

import { useEffect, useState, type RefObject } from "react";

type ContentRect = { x: number; y: number; width: number; height: number; blocked: boolean };
interface ShellPresentation {
	version: number;
	reportLayout(rect: ContentRect | null): Promise<void>;
	showWeb(): Promise<void>;
	onLocalChange(listener: (active: boolean) => void): () => void;
}
function bridge() {
	return (window as unknown as { laplaceShell?: ShellPresentation }).laplaceShell;
}

/** Keep hosted navigation mounted while Electron draws trusted local content in its slot. */
export function useDesktopLocalContent(
	content: RefObject<HTMLElement | null>,
	route: string,
	enabled: boolean,
) {
	const [active, setActive] = useState(false);
	useEffect(() => {
		const shell = bridge();
		if (!enabled || shell?.version !== 1 || !content.current) return;
		const element = content.current;
		const unsubscribe = shell.onLocalChange(setActive);
		let previous = "";
		let frame = 0;
		const report = () => {
			frame = 0;
			const bounds = element.getBoundingClientRect();
			// Native views sit above DOM portals. Yield while a web menu or dialog is open.
			const blocked = [
				...document.querySelectorAll<HTMLElement>(
					'[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-desktop-overlay]',
				),
			].some(
				(node) =>
					node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden",
			);
			const rect =
				bounds.width > 0 && bounds.height > 0
					? {
							x: Math.max(0, bounds.x),
							y: Math.max(0, bounds.y),
							width: bounds.width,
							height: bounds.height,
							blocked,
						}
					: null;
			const key = JSON.stringify(rect);
			if (key !== previous) {
				previous = key;
				void shell.reportLayout(rect).catch(() => {});
			}
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(report);
		};
		const resize = new ResizeObserver(schedule);
		resize.observe(element);
		const mutations = new MutationObserver(schedule);
		mutations.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [
				"class",
				"style",
				"hidden",
				"data-state",
				"data-open",
				"data-closed",
				"role",
			],
		});
		window.addEventListener("resize", schedule);
		// Same-route links must also leave local content; route-change effects alone miss those.
		const navigate = (event: MouseEvent) => {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
				return;
			const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
			if (
				!(link instanceof HTMLAnchorElement) ||
				link.target === "_blank" ||
				link.hasAttribute("download")
			)
				return;
			const url = new URL(link.href);
			if (url.origin === location.origin && url.href !== `${location.origin}/desktop/local`)
				void shell.showWeb().catch(() => {});
		};
		document.addEventListener("click", navigate, true);
		report();
		return () => {
			unsubscribe();
			resize.disconnect();
			mutations.disconnect();
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", schedule);
			document.removeEventListener("click", navigate, true);
			void shell.reportLayout(null).catch(() => {});
		};
	}, [content, enabled]);
	useEffect(() => {
		if (enabled)
			void bridge()
				?.showWeb()
				.catch(() => {});
	}, [route, enabled]);
	return active;
}
