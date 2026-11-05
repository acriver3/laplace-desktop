// Fixed login operations only. Never return page text, filled values, cookies or DOM.
async function loginStep(command, input) {
	const visible = (e) => {
		const r = e.getBoundingClientRect(),
			s = getComputedStyle(e);
		return (
			r.width > 0 &&
			r.height > 0 &&
			s.visibility !== "hidden" &&
			s.display !== "none" &&
			s.opacity !== "0"
		);
	};
	const handles = (globalThis.__laplaceLoginHandles ??= new WeakMap());
	const handle = (e) => {
		if (!handles.has(e)) handles.set(e, crypto.randomUUID());
		return handles.get(e);
	};
	const describe = () => {
		let reason;
		const usernames = [
			...document.querySelectorAll('input[autocomplete="username"],input[type="email"]'),
		].filter((e) => visible(e) && !e.disabled && !e.readOnly);
		const passwords = [...document.querySelectorAll('input[type="password"]')].filter(
			(e) => visible(e) && !e.disabled && !e.readOnly,
		);
		const elements = [...usernames, ...passwords],
			form = elements[0]?.form;
		if (
			window !== window.top ||
			[...document.querySelectorAll('iframe,input[autocomplete="one-time-code"]')].some(visible)
		)
			reason = "unsupported_frame_or_challenge";
		else if (
			usernames.length > 1 ||
			passwords.length > 1 ||
			!form ||
			elements.some((e) => e.form !== form) ||
			new URL(form.action || location.href, location.href).origin !== location.origin
		)
			reason = "ambiguous_or_unsupported_form";
		const buttons = form
			? [
					...form.querySelectorAll(
						"button[type=submit],button[type=button],button:not([type]),input[type=submit]",
					),
				].filter(
					(e) =>
						visible(e) &&
						!e.disabled &&
						/^(next|continue|sign in|log in|login)$/i.test(
							(e instanceof HTMLInputElement ? e.value : (e.textContent ?? "")).trim(),
						),
				)
			: [];
		if (!reason && buttons.length !== 1) reason = "ambiguous_submit";
		if (
			!reason &&
			(new URL(buttons[0].getAttribute("formaction") || form.action || location.href, location.href)
				.origin !== location.origin ||
				(buttons[0].getAttribute("formtarget") || form.target || "_self") !== "_self")
		)
			reason = "ambiguous_or_unsupported_form";
		const fields = reason
			? []
			: [...(usernames.length ? ["username"] : []), ...(passwords.length ? ["password"] : [])];
		const ids = reason ? [] : elements.map(handle);
		const shape = JSON.stringify([
			location.href,
			form ? handle(form) : "",
			form?.action,
			fields,
			ids,
			buttons.map((b) => [handle(b), b.getAttribute("formaction"), b.getAttribute("formtarget")]),
			form?.target,
		]);
		return {
			shape,
			observation: {
				origin: location.origin,
				fields,
				handles: ids,
				handoff: !!reason,
				...(reason ? { handoffReason: reason } : {}),
			},
			elements,
			buttons,
		};
	};
	const before = describe();
	const revision = [
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(before.shape)),
		),
	]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	if (command === "inspect") return { ...before.observation, revision };
	// Hashing yields: recheck synchronously before touching fields.
	if (describe().shape !== before.shape) return { done: false };
	if (
		command !== "advance" ||
		!Number.isFinite(input.expires) ||
		Date.now() >= input.expires ||
		before.observation.handoff ||
		revision !== input.revision ||
		location.origin !== input.origin
	)
		return { done: false };
	const used = (globalThis.__laplaceLoginSubmissions ??= new Set());
	if (used.has(input.revision)) return { done: false };
	if (
		before.observation.fields.some((f) => typeof input.values?.[f] !== "string" || !input.values[f])
	)
		return { done: false };
	// Mark intent before changing any field. A failed or uncertain submission is never replayed.
	used.add(input.revision);
	for (let i = 0; i < before.elements.length; i++) {
		if (
			Date.now() >= input.expires ||
			describe().shape !== before.shape ||
			location.origin !== input.origin
		)
			return { done: false };
		const e = before.elements[i],
			value = input.values[before.observation.fields[i]];
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, value);
		e.dispatchEvent(new Event("input", { bubbles: true }));
		e.dispatchEvent(new Event("change", { bubbles: true }));
	}
	const after = describe();
	if (
		Date.now() >= input.expires ||
		after.observation.handoff ||
		after.shape !== before.shape ||
		location.origin !== input.origin
	)
		return { done: false };
	after.buttons[0].click();
	return { done: true };
}

export async function connectBroker(ticket, tabId) {
	const base = new URL(ticket.base);
	if (
		base.protocol !== "http:" ||
		base.hostname !== "127.0.0.1" ||
		!base.port ||
		base.origin !== ticket.base ||
		!Number.isInteger(tabId)
	)
		throw Error();
	let token;
	const permissionPrompts = new Set();
	const request = async (path, body = {}) => {
		const r = await fetch(base.origin + path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: "Bearer " + token } : {}),
			},
			body: JSON.stringify({ id: ticket.id, ...body }),
			credentials: "omit",
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		});
		if (!r.ok) throw Error();
		return r.json();
	};
	const initial = await request("/connect", { code: ticket.code });
	token = initial.token;
	if (initial.checkOnly) return { connected: true };
	const destination = new URL(initial.url);
	if (destination.protocol !== "https:" || destination.username || destination.password)
		throw Error();
	await chrome.tabs.update(tabId, { url: initial.url, active: true });
	initial.url = undefined;
	ticket.code = undefined;
	void (async () => {
		try {
			while (Date.now() < initial.expires) {
				const next = await request("/next");
				if (next) {
					let result,
						ok = false;
					try {
						if (next.method === "focus") {
							const tab = await chrome.tabs.update(tabId, { active: true });
							await chrome.windows.update(tab.windowId, { focused: true });
							result = { done: true };
							ok = true;
						} else if (["inspect", "advance"].includes(next.method)) {
							const tab = await chrome.tabs.get(tabId),
								current = new URL(tab.url);
							if (
								next.method === "inspect" &&
								(!next.input.origins?.includes(current.origin) ||
									!(await chrome.permissions.contains({ origins: [current.origin + "/*"] })))
							) {
								if (
									next.input.origins?.includes(current.origin) &&
									!permissionPrompts.has(current.origin)
								) {
									permissionPrompts.add(current.origin);
									await chrome.tabs.create({
										url:
											chrome.runtime.getURL("broker-permission.html") +
											"#" +
											encodeURIComponent(current.origin),
										active: true,
									});
								}
								result = {
									origin: current.origin,
									revision: "0".repeat(64),
									fields: [],
									handles: [],
									handoff: true,
									handoffReason: "permission_required",
								};
								ok = true;
							} else {
								if (
									current.protocol !== "https:" ||
									!(await chrome.permissions.contains({ origins: [current.origin + "/*"] }))
								)
									throw Error();
								const results = await chrome.scripting.executeScript({
									target: { tabId },
									world: "ISOLATED",
									func: loginStep,
									args: [next.method, next.input],
								});
								result = results.find((r) => r.frameId === 0)?.result;
								ok = next.method === "inspect" ? !!result : result?.done === true;
							}
						}
					} catch {}
					// Credentials exist only in this iteration's input and the destination fields.
					next.input = undefined;
					await request("/result", { requestId: next.id, ok, ...(ok ? { result } : {}) });
				}
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
		} catch {
			/* Tab closure, lock, cancellation and restart require a fresh review. */
		}
	})();
	return { connected: true };
}
