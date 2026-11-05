import { createHash } from "node:crypto";

import { browserTargets, cdpOrigin, Cdp } from "./credentials-cdp";

/** Only this fixed inspection program runs in the page. No page text or values leave it. */
function describeLogin() {
	const visible = (e: Element) => {
		const rect = e.getBoundingClientRect(),
			style = getComputedStyle(e);
		return (
			rect.width > 0 &&
			rect.height > 0 &&
			style.visibility !== "hidden" &&
			style.display !== "none" &&
			style.opacity !== "0"
		);
	};
	if (
		window !== window.top ||
		[...document.querySelectorAll("iframe,input[autocomplete=one-time-code]")].some(visible)
	)
		return {
			handoff: true,
			reason: "unsupported_frame_or_challenge",
			fields: [] as string[],
			submit: false,
			form: "",
		};
	const username = [
		...document.querySelectorAll<HTMLInputElement>(
			'input[autocomplete="username"],input[type="email"]',
		),
	].filter((e) => visible(e) && !e.disabled && !e.readOnly);
	const password = [
		...document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
	].filter((e) => visible(e) && !e.disabled && !e.readOnly);
	if (username.length > 1 || password.length > 1)
		return {
			handoff: true,
			reason: "ambiguous_or_unsupported_form",
			fields: [],
			submit: false,
			form: "",
		};
	const fields = [
		...(username.length ? ["username"] : []),
		...(password.length ? ["password"] : []),
	];
	const elements = [...username, ...password];
	const form = elements[0]?.form;
	if (
		!form ||
		elements.some((e) => e.form !== form) ||
		new URL(form.action || location.href, location.href).origin !== location.origin
	)
		return {
			handoff: true,
			reason: "ambiguous_or_unsupported_form",
			fields: [],
			submit: false,
			form: "",
		};
	const buttons = [
		...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
			"button[type=submit],button:not([type]),input[type=submit]",
		),
	].filter(
		(e) =>
			visible(e) &&
			!e.disabled &&
			/^(next|continue|sign in|log in|login)$/i.test(
				(e instanceof HTMLInputElement ? e.value : (e.textContent ?? "")).trim(),
			),
	);
	const state = globalThis as typeof globalThis & {
		__laplaceBrokerHandles?: WeakMap<Element, string>;
	};
	const handles = (state.__laplaceBrokerHandles ??= new WeakMap<Element, string>());
	const handle = (e: Element) => {
		let id = handles.get(e);
		if (!id) {
			id = crypto.randomUUID();
			handles.set(e, id);
		}
		return id;
	};
	return {
		handoff: fields.length === 0 || buttons.length !== 1,
		reason:
			fields.length === 0
				? "no_login_fields"
				: buttons.length !== 1
					? "ambiguous_submit"
					: undefined,
		fields,
		submit: buttons.length === 1,
		form: handle(form) + "|" + new URL(form.action || location.href, location.href).href,
		handles: elements.map(handle),
	};
}
export interface LoginObservation {
	origin: string;
	revision: string;
	fields: string[];
	handles: string[];
	handoff: boolean;
	handoffReason?: string;
}
export class BrokerBrowser {
	private revisions = new Map<string, { revision: string; origin: string; description: string }>();
	constructor(private endpoint: () => string) {}
	async open(url: string, signal: AbortSignal) {
		const destination = new URL(url);
		if (destination.protocol !== "https:" || destination.username || destination.password)
			throw Error("Unsupported sign-in URL.");
		const base = cdpOrigin(this.endpoint());
		const response = await fetch(base + "/json/new?" + encodeURIComponent(url), {
			method: "PUT",
			redirect: "error",
			signal,
		});
		if (!response.ok) throw Error("Open a compatible browser in Desktop.");
		const tab = (await response.json()) as { id?: string };
		if (!tab.id || !/^[A-Za-z0-9_-]{1,128}$/.test(tab.id)) throw Error("Browser tab unavailable.");
		return tab.id;
	}
	private async page(targetId: string, signal: AbortSignal) {
		const target = (await browserTargets(this.endpoint(), signal)).find((t) => t.id === targetId);
		if (!target) throw Error("Browser target unavailable.");
		const cdp = new Cdp(target.socket, signal);
		const tree = await cdp.call("Page.getFrameTree");
		const world = await cdp.call("Page.createIsolatedWorld", {
			frameId: tree.frameTree.frame.id,
			worldName: "laplace-broker",
		});
		return {
			target,
			cdp,
			contextId: world.executionContextId,
			loaderId: tree.frameTree.frame.loaderId,
		};
	}
	async inspect(targetId: string, signal: AbortSignal): Promise<LoginObservation> {
		const { target, cdp, contextId, loaderId } = await this.page(targetId, signal);
		try {
			const result = await cdp.call("Runtime.evaluate", {
				contextId,
				returnByValue: true,
				expression: "(" + describeLogin.toString() + ")()",
			});
			const value = result.result?.value;
			if (
				result.exceptionDetails ||
				!value ||
				typeof value.form !== "string" ||
				!Array.isArray(value.fields) ||
				value.fields.some((f: unknown) => f !== "username" && f !== "password")
			)
				throw Error("Login needs user attention.");
			const description = JSON.stringify({
				fields: value.fields,
				submit: value.submit,
				form: value.form,
				handles: value.handles,
			});
			const revision = createHash("sha256")
				.update(targetId + target.origin + loaderId + description)
				.digest("hex");
			this.revisions.set(targetId, { revision, origin: target.origin, description });
			return {
				origin: target.origin,
				revision,
				fields: value.fields,
				handles: value.handles ?? [],
				handoff: value.handoff !== false,
				...(value.handoff && typeof value.reason === "string"
					? { handoffReason: value.reason }
					: {}),
			};
		} finally {
			cdp.close();
		}
	}
	async advance(
		targetId: string,
		revision: string,
		values: Record<string, string>,
		signal: AbortSignal,
	) {
		const before = await this.inspect(targetId, signal);
		if (before.revision !== revision || before.handoff || before.fields.some((f) => !values[f]))
			throw Error("Login changed or needs the user.");
		const fields = Object.fromEntries(before.fields.map((f) => [f, values[f]!]));
		const { target, cdp, contextId } = await this.page(targetId, signal);
		try {
			if (target.origin !== before.origin) throw Error("Login origin changed.");
			const result = await cdp.call("Runtime.evaluate", {
				contextId,
				returnByValue: true,
				expression:
					"(()=>{const expected=" +
					JSON.stringify(this.revisions.get(targetId)!.description) +
					";const inspect=(" +
					describeLogin.toString() +
					");const shape=d=>JSON.stringify({fields:d.fields,submit:d.submit,form:d.form,handles:d.handles});if(location.origin!==" +
					JSON.stringify(before.origin) +
					")return false;const d=inspect();if(d.handoff||shape(d)!==expected)return false;const values=" +
					JSON.stringify(fields) +
					";const selectors={username:'input[autocomplete=username],input[type=email]',password:'input[type=password]'};const fields=[];for(const [key,value] of Object.entries(values)){const matches=[...document.querySelectorAll(selectors[key])].filter(e=>e.getClientRects().length&&!e.disabled&&!e.readOnly);if(matches.length!==1)return false;fields.push([matches[0],value]);}for(const [e,v] of fields)Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);for(const [e] of fields){e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}const next=inspect();if(next.handoff||shape(next)!==expected)return false;const form=fields[0][0].form;const buttons=[...form.querySelectorAll('button[type=submit],button:not([type]),input[type=submit]')].filter(e=>e.getClientRects().length&&!e.disabled&&/^(next|continue|sign in|log in|login)$/i.test((e.value||e.textContent||'').trim()));if(buttons.length!==1)return false;buttons[0].click();return true;})()",
			});
			if (result.exceptionDetails || result.result?.value !== true)
				throw Error("Sign-in submission was not confirmed.");
			return { submitted: true };
		} finally {
			cdp.close();
		}
	}
	async focus(targetId: string, signal: AbortSignal) {
		const { cdp } = await this.page(targetId, signal);
		try {
			await cdp.call("Page.bringToFront");
		} finally {
			cdp.close();
		}
	}
}
