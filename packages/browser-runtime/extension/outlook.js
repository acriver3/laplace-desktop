/** Reviewed Outlook operations. Serialized into the selected tab; keep self-contained.
 * MSAL storage format: microsoft-authentication-library-for-js/lib/msal-browser/src/cache.
 * Tokens are read and used only inside Chrome, never returned to the local relay.
 */
export async function outlookAction(method, args = {}, expected, workspace) {
	const home = "https://outlook.cloud.microsoft";
	const clientId = "9199bf20-a13f-4107-85dc-02114787ef48";
	const hosts = ["outlook.cloud.microsoft", "outlook.office.com", "outlook.office365.com"];
	const fail = (error) => ({ ok: false, error });
	if (location.protocol !== "https:" || !hosts.includes(location.hostname) || workspace !== home)
		return fail("not_outlook_tab");
	const decode = (value) =>
		Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
	const parse = (value) => {
		try {
			return JSON.parse(value);
		} catch {
			return null;
		}
	};
	const jwt = (value) => {
		try {
			return parse(new TextDecoder().decode(decode(value.split(".")[1])));
		} catch {
			return null;
		}
	};
	const stores = [sessionStorage, localStorage];
	const read = (key) => stores.map((s) => s.getItem(key)).find(Boolean);
	let encryption;
	try {
		const cookie = document.cookie
			.split(";")
			.map((s) => s.trim())
			.find((s) => s.startsWith("msal.cache.encryption="));
		const value = cookie && parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)));
		if (value?.id && value?.key)
			encryption = {
				id: value.id,
				key: await crypto.subtle.importKey("raw", decode(value.key), "HKDF", false, ["deriveKey"]),
			};
	} catch {
		/* A missing encryption key means the user must finish signing in. */
	}
	async function entry(key, raw) {
		const value = parse(raw);
		if (!value?.nonce || !value?.data || value.secret) return value;
		if (!encryption || value.id !== encryption.id) return null;
		try {
			const derived = await crypto.subtle.deriveKey(
				{
					name: "HKDF",
					salt: decode(value.nonce),
					hash: "SHA-256",
					info: new TextEncoder().encode(key.includes(clientId) ? clientId : ""),
				},
				encryption.key,
				{ name: "AES-GCM", length: 256 },
				false,
				["decrypt"],
			);
			return parse(
				new TextDecoder().decode(
					await crypto.subtle.decrypt(
						{ name: "AES-GCM", iv: new Uint8Array(12) },
						derived,
						decode(value.data),
					),
				),
			);
		} catch {
			return null;
		}
	}
	// Never select whichever cached token expires latest across accounts. Bind to
	// MSAL's active account. Ambiguous or absent active state requires user sign-in.
	const activeKey = `msal.${clientId}.active-account-filters`;
	const activeRaw = read(activeKey);
	const active = activeRaw && (await entry(activeKey, activeRaw));
	if (!active?.homeAccountId || !active?.localAccountId || !active?.tenantId)
		return fail("sign_in_required");
	const identity = {
		workspace: home,
		userId: active.localAccountId,
		tenantId: active.tenantId,
		accountId: active.homeAccountId,
	};
	const same = (value) =>
		value && Object.keys(identity).every((key) => value[key] === identity[key]);
	if (expected && !same(expected)) return fail("identity_mismatch");
	const tokens = {};
	for (const storage of stores) {
		for (const key of Object.keys(storage)) {
			if (!key.startsWith("msal.") || !key.toLowerCase().includes("accesstoken")) continue;
			const value = await entry(key, storage.getItem(key));
			if (
				!value?.secret ||
				value.homeAccountId !== active.homeAccountId ||
				value.realm !== active.tenantId ||
				value.clientId !== clientId
			)
				continue;
			const claims = jwt(value.secret);
			if (
				claims &&
				((claims.oid && claims.oid !== active.localAccountId) ||
					(claims.tid && claims.tid !== active.tenantId))
			)
				continue;
			const expires = Number(value.expiresOn || claims?.exp) * 1000;
			if (!Number.isFinite(expires) || expires <= Date.now() + 5000) continue;
			const service = value.target?.includes("outlook.office.com")
				? "owa"
				: value.target?.includes("graph.microsoft.com")
					? "graph"
					: null;
			if (service && (!tokens[service] || tokens[service].expires < expires))
				tokens[service] = {
					secret: value.secret,
					expires,
					upn: claims?.upn || claims?.preferred_username,
				};
		}
	}
	if (!tokens.owa) return fail("sign_in_required");
	if (method === "account.identify")
		return {
			ok: true,
			result: { ...identity, ...(tokens.owa.upn ? { accountLabel: tokens.owa.upn } : {}) },
		};
	if (method === "account.status")
		return {
			ok: true,
			result: {
				authenticated: true,
				upn: tokens.owa.upn,
				tenantId: identity.tenantId,
				owaToken: {
					expiresAt: new Date(tokens.owa.expires).toISOString(),
					minutesRemaining: Math.floor((tokens.owa.expires - Date.now()) / 60000),
				},
				graphToken: tokens.graph
					? { expiresAt: new Date(tokens.graph.expires).toISOString() }
					: null,
				session: { exists: true, likelyExpired: false },
			},
		};
	if (!expected) return fail("identity_mismatch");
	// Fixed resources and verbs only. No absolute URLs, traversal, batch endpoints,
	// authentication endpoints, or caller-controlled headers can enter this adapter.
	const segment = "[^/?#\\\\\\s]+";
	const patterns = {
		"owa.get": [
			"/(?:messages|mailfolders|calendars|contacts|people|mailboxsettings|calendarview)",
			`/mailfolders/${segment}(?:/messages|/childfolders)?`,
			`/messages/${segment}(?:/attachments(?:/${segment})?)?`,
			`/events/${segment}`,
			`/contacts/${segment}`,
			`/calendars/${segment}/calendarview`,
		],
		"owa.post": [
			"/(?:sendmail|messages|events|contacts|mailfolders|getmailtips|findmeetingtimes|calendar/getschedule)",
			`/messages/${segment}/(?:reply|replyall|createreply|createreplyall|createforward|forward|move|send|attachments)`,
			`/events/${segment}/(?:accept|tentativelyaccept|decline|cancel|forward)`,
			`/mailfolders/${segment}/childfolders`,
		],
		"owa.patch": ["/mailboxsettings", `/(?:messages|events|mailfolders)/${segment}`],
		"owa.delete": [`/(?:messages|events|contacts|mailfolders)/${segment}`],
		"owa.cloudSettings": ["/settings/?", "/settings/account"],
		"graph.getPath": [`/(?:me|users/${segment})(?:/manager|/directReports)?`],
		"graph.binary": [`/(?:me|users/${segment})/photo/\\$value`],
	};
	const path = args.path;
	if (
		typeof path !== "string" ||
		path.length > 4096 ||
		/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c|[\\\\?#]/i.test(path) ||
		!patterns[method]?.some((pattern) => new RegExp("^" + pattern + "$", "i").test(path))
	)
		return fail("invalid_request");
	if (
		args.params &&
		(typeof args.params !== "object" ||
			Object.entries(args.params).some(
				([key, value]) =>
					typeof value !== "string" ||
					value.length > 8000 ||
					![
						"$select",
						"$top",
						"$skip",
						"$orderby",
						"$filter",
						"$search",
						"$expand",
						"$count",
						"startDateTime",
						"endDateTime",
						"settingname",
					].includes(key),
			))
	)
		return fail("invalid_request");
	const graph = method.startsWith("graph.");
	const token = graph ? tokens.graph : tokens.owa;
	if (!token)
		return {
			ok: true,
			result: {
				error: "Graph session unavailable. Open the intended account in Outlook and refresh it.",
			},
		};
	const url = new URL(
		(graph
			? "https://graph.microsoft.com/v1.0"
			: method === "owa.cloudSettings"
				? home + "/ows/v1/OutlookCloudSettings"
				: "https://outlook.office.com/api/v2.0/me") + path,
	);
	for (const [key, value] of Object.entries(args.params || {})) url.searchParams.set(key, value);
	const verb =
		{ "owa.post": "POST", "owa.patch": "PATCH", "owa.delete": "DELETE" }[method] || "GET";
	// Re-check the active account immediately before dispatch, including after the
	// asynchronous key decryption. A write is dispatched once, with no retry loop.
	if (read(activeKey) !== activeRaw) return fail("identity_mismatch");
	try {
		const response = await fetch(url.href, {
			method: verb,
			credentials: "same-origin",
			redirect: "error",
			headers: {
				Authorization: `Bearer ${token.secret}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				...(args.large ? { "x-islargesetting": "true" } : {}),
			},
			...(verb === "POST" || verb === "PATCH" ? { body: JSON.stringify(args.body) } : {}),
			signal: AbortSignal.timeout(90000),
		});
		if (!response.ok)
			return {
				ok: true,
				result: {
					error: `Outlook HTTP ${response.status}. ${verb === "GET" ? "Check the selected account and retry only when ready." : "The operation was not retried. Verify its outcome before trying again."}`,
				},
			};
		if (
			response.status === 204 ||
			(Number(response.headers.get("content-length")) === 0 &&
				response.headers.has("content-length"))
		)
			return { ok: true, result: null };
		if (
			method !== "graph.binary" &&
			!(response.headers.get("content-type") || "").includes("application/json")
		)
			return { ok: true, result: null };
		const max = 24 * 1024 * 1024;
		if (Number(response.headers.get("content-length")) > max) throw Error("Response too large");
		const reader = response.body.getReader();
		const chunks = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > max) throw Error("Response too large");
				chunks.push(value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		if (method === "graph.binary") {
			let binary = "";
			for (let i = 0; i < bytes.length; i += 8192)
				binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
			return {
				ok: true,
				result: {
					contentType: response.headers.get("content-type") || "application/octet-stream",
					base64: btoa(binary),
				},
			};
		}
		const text = new TextDecoder().decode(bytes);
		return { ok: true, result: text ? JSON.parse(text) : null };
	} catch {
		// Failure after dispatch is uncertain for writes, even if the browser lost
		// the response after Outlook committed it. The relay never replays it.
		return fail(verb === "GET" ? "request_failed" : "SAVE_UNVERIFIED");
	}
}
