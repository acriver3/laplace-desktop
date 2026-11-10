import { useSyncExternalStore } from "react";

import { catalogSetupTarget, type CatalogSetupTarget } from "../shared/catalog-setup";

const key = "laplace:setup-agent";
const changed = "laplace:setup-agent-changed";
let fallback: CatalogSetupTarget | null = null;

function read() {
	try {
		const value = catalogSetupTarget.safeParse(localStorage.getItem(key));
		return value.success ? value.data : fallback;
	} catch {
		return fallback;
	}
}

function subscribe(notify: () => void) {
	window.addEventListener("storage", notify);
	window.addEventListener(changed, notify);
	return () => {
		window.removeEventListener("storage", notify);
		window.removeEventListener(changed, notify);
	};
}

function remember(target: CatalogSetupTarget) {
	fallback = target;
	try {
		localStorage.setItem(key, target);
	} catch {
		// Keep the selection for this session when persistent storage is unavailable.
	}
	window.dispatchEvent(new Event(changed));
}

export function useSetupAgent() {
	return [useSyncExternalStore(subscribe, read, () => null), remember] as const;
}
