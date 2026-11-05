import type { CatalogEntry } from "./types";

/** Use the installed runtime's mode, never the newest catalog runtime's mode. */
export function connectionName(name: string, mode?: CatalogEntry["browserMode"]) {
	if (!mode) return name;
	const label = mode === "tethered" ? "Tethered" : "Background Browser";
	return `${name.replace(/\s*\[(?:Tethered|Background Browser)\]/g, "")} [${label}]`;
}
