import { profiles, type Profile } from "../shared/shell-contracts";

export const desktopUserAgentToken = "LaplaceDesktop/0.1";

/** Desktop reopens the last Connect page; login and desktop handoff pages restart at Connect's home. */
export function restorableWebUrl(value: string | undefined, origin: string): string {
	try {
		const url = new URL(value ?? "");
		if (
			url.origin === origin &&
			!url.username &&
			!url.password &&
			url.pathname !== "/login" &&
			!url.pathname.startsWith("/desktop/")
		)
			return url.href;
	} catch {
		/* fall back to the workspace home */
	}
	return `${origin}/`;
}

/** Connect sends an expired or revoked session to its login page. */
export function webSessionEnded(value: string, origin: string): boolean {
	try {
		const url = new URL(value);
		return url.origin === origin && url.pathname === "/login";
	} catch {
		return false;
	}
}

/** This action only reveals the bundled manager; it cannot invoke its operations. */
export function desktopLocalNavigation(
	primary: boolean,
	source: string,
	destination: string,
	connectOrigin: string,
): boolean {
	if (!primary) return false;
	try {
		const from = new URL(source);
		const to = new URL(destination);
		return (
			from.origin === connectOrigin &&
			!from.username &&
			!from.password &&
			to.href === `${connectOrigin}/desktop/local`
		);
	} catch {
		return false;
	}
}

export function permittedWebOrigin(profile: Profile, value: string): boolean {
	try {
		const url = new URL(value);
		if (url.username || url.password) return false;
		const allowed =
			profile === "hosted"
				? [
						profiles.hosted.origin,
						"https://builder.withlaplace.com",
						"https://build.withlaplace.com",
						"https://builder-preview.withlaplace.com",
					]
				: [
						profiles.local.origin,
						"http://localhost:3004",
						"http://127.0.0.1:5174",
						"http://localhost:5174",
					];
		return allowed.includes(url.origin);
	} catch {
		return false;
	}
}

export function externalUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
			? url.href
			: null;
	} catch {
		return null;
	}
}

export function trustedRenderer(value: string, developmentUrl?: string): boolean {
	try {
		const url = new URL(value);
		return developmentUrl
			? url.origin === new URL(developmentUrl).origin
			: url.protocol === "laplace-desktop:" && url.hostname === "app";
	} catch {
		return false;
	}
}

/** Only Connect may hand off the specific draft/install routes used by its agent actions. */
export function agentHandoffUrl(
	value: string,
	source: string,
	connectOrigin: string,
): string | null {
	try {
		const from = new URL(source);
		const url = new URL(value);
		if (
			from.origin !== connectOrigin ||
			from.username ||
			from.password ||
			url.username ||
			url.password ||
			url.port ||
			url.hash
		)
			return null;
		const route = `${url.protocol}//${url.hostname}${url.pathname}`;
		return [
			"codex://threads/new",
			"claude://claude.ai/new",
			"claude://code/new",
			"cursor://anysphere.cursor-deeplink/mcp/install",
		].includes(route)
			? url.href
			: null;
	} catch {
		return null;
	}
}

/** Authorize the write-only clipboard bridge for the primary Connect frame. */
export function connectClipboardWrite(
	primary: boolean,
	mainFrame: boolean,
	requestingUrl: string | undefined,
	connectOrigin: string,
): boolean {
	if (!primary || !mainFrame) return false;
	try {
		const url = new URL(requestingUrl ?? "");
		return url.origin === connectOrigin && !url.username && !url.password;
	} catch {
		return false;
	}
}
