const servicePattern = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Selection only: consuming a link must never connect, authenticate, or disconnect. */
export function connectionSelection(search: URLSearchParams) {
	const read = (name: string, pattern: RegExp) => {
		const values = search.getAll(name);
		return values.length === 1 && pattern.test(values[0]) ? values[0] : undefined;
	};
	const installationId = read("installation", uuidPattern);
	return {
		provider: read("provider", servicePattern),
		setup: read("setup", servicePattern),
		installationId,
		connectionId: installationId ? read("localConnection", uuidPattern) : undefined,
		demo: search.get("demo") === "ycombinator",
	};
}

export function connectionUrl(
	origin: string,
	slug: string | null,
	selection: {
		provider?: string;
		setup?: string;
		installationId?: string;
		connectionId?: string;
		demo?: boolean;
	} = {},
) {
	const url = new URL(slug ? `/${encodeURIComponent(slug)}/connections` : "/", origin);
	if (selection.provider && servicePattern.test(selection.provider))
		url.searchParams.set("provider", selection.provider);
	if (selection.setup && servicePattern.test(selection.setup))
		url.searchParams.set("setup", selection.setup);
	if (selection.installationId && uuidPattern.test(selection.installationId)) {
		url.searchParams.set("installation", selection.installationId);
		if (selection.connectionId && uuidPattern.test(selection.connectionId))
			url.searchParams.set("localConnection", selection.connectionId);
	}
	if (selection.demo) url.searchParams.set("demo", "ycombinator");
	return url.href;
}
