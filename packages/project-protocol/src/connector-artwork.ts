/** Resolve only vendored artwork; both browser and MCP Home use this fallback. */
export function providerLogoPath(service: string, providers: Record<string, string | null>) {
	const path =
		service === "ycombinator" ? "/images/provider-logos/ycombinator-demo.svg" : providers[service];
	return path?.startsWith("/images/provider-logos/") ? path : undefined;
}

export const providerInitials = (name: string) =>
	Array.from(name).slice(0, 2).join("").toUpperCase();
