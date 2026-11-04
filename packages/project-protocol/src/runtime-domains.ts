export interface RuntimeDomains {
	APP_RUNTIME_DOMAIN?: string;
	APP_RUNTIME_LEGACY_DOMAINS?: string;
}

/** Explicit aliases only; never infer trust from a registrable parent domain. */
export function runtimeDomains(env: RuntimeDomains): string[] {
	if (!env.APP_RUNTIME_DOMAIN) {
		if (env.APP_RUNTIME_LEGACY_DOMAINS)
			throw new Error("Runtime aliases require a canonical domain");
		return [];
	}
	const values = [
		env.APP_RUNTIME_DOMAIN,
		...(env.APP_RUNTIME_LEGACY_DOMAINS?.split(",") ?? []),
	].map((value) => value.trim());
	if (
		values.length > 8 ||
		values.some(
			(value) =>
				value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(value),
		)
	)
		throw new Error("Invalid runtime domain configuration");
	return [...new Set(values)];
}

export function matchRuntimeDomain(hostname: string, env: RuntimeDomains): string | undefined {
	return runtimeDomains(env).find((domain) => {
		if (!hostname.endsWith(`.${domain}`)) return false;
		const label = hostname.slice(0, -(domain.length + 1));
		return label.length > 0 && !label.includes(".");
	});
}
