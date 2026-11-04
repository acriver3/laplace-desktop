/** This adapter only connects to an explicitly configured local browser. No discovery or launch. */
export function cdpOrigin(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("Use a loopback CDP HTTP origin, such as http://127.0.0.1:9222");
	return url.origin;
}

export async function browserTargets(endpoint: string, signal: AbortSignal) {
	const origin = cdpOrigin(endpoint);
	const response = await fetch(`${origin}/json/list`, {
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
	});
	if (!response.ok || Number(response.headers.get("content-length")) > 262144)
		throw new Error("Browser unavailable");
	const reader = response.body!.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.length;
			if (bytes > 262144) throw new Error("Browser response too large");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const data: unknown = JSON.parse(Buffer.concat(chunks).toString());
	if (!Array.isArray(data)) throw new Error("Invalid browser response");
	return data.flatMap((target) => {
		try {
			if (target.type !== "page" || !/^[A-Za-z0-9_-]{1,128}$/.test(target.id)) return [];
			const page = new URL(target.url),
				ws = new URL(target.webSocketDebuggerUrl);
			if (
				page.protocol !== "https:" ||
				ws.protocol !== "ws:" ||
				ws.host !== new URL(origin).host ||
				ws.username ||
				ws.password ||
				ws.search ||
				ws.hash ||
				ws.pathname !== `/devtools/page/${target.id}`
			)
				return [];
			return [{ id: target.id as string, origin: page.origin, socket: ws.href }];
		} catch {
			return [];
		}
	});
}

class Cdp {
	private sequence = 0;
	private pending = new Map<number, { resolve: (v: any) => void; reject: () => void }>();
	private socket: WebSocket;
	private ready: Promise<void>;
	private closeListener: () => void;
	constructor(
		url: string,
		private signal: AbortSignal,
	) {
		this.socket = new WebSocket(url);
		this.ready = new Promise((resolve, reject) => {
			this.socket.addEventListener("open", () => resolve(), { once: true });
			this.socket.addEventListener("error", () => reject(new Error("Browser unavailable")), {
				once: true,
			});
			this.socket.addEventListener("close", () => reject(new Error("Browser disconnected")), {
				once: true,
			});
		});
		this.socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data.length > 262144) {
				this.close();
				return;
			}
			try {
				const message = JSON.parse(event.data),
					pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				if (message.error) pending.reject();
				else pending.resolve(message.result);
			} catch {
				this.close();
			}
		});
		this.closeListener = () => this.close();
		this.socket.addEventListener("close", () => this.fail());
		this.socket.addEventListener("error", () => this.fail());
		signal.addEventListener("abort", this.closeListener, { once: true });
		if (signal.aborted) this.close();
	}
	private fail() {
		for (const p of this.pending.values()) p.reject();
		this.pending.clear();
	}
	async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
		await this.ready;
		this.signal.throwIfAborted();
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject: () => reject(new Error("Browser operation failed")),
			});
			try {
				this.socket.send(JSON.stringify({ id, method, params }));
			} catch {
				this.pending.delete(id);
				reject(new Error("Browser unavailable"));
			}
		});
	}
	close() {
		this.signal.removeEventListener("abort", this.closeListener);
		this.fail();
		this.socket.close();
	}
}

/** No secret is returned, including when a site or CDP endpoint returns an unexpected result. */
export async function fillBrowser(
	endpoint: string,
	targetId: string,
	origins: string[],
	values: Record<string, string>,
	signal: AbortSignal,
) {
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
	const target = (await browserTargets(endpoint, bounded)).find((t) => t.id === targetId);
	if (!target || !origins.includes(target.origin))
		throw new Error("Browser target unavailable or origin mismatch");
	const cdp = new Cdp(target.socket, bounded);
	try {
		const tree = await cdp.call("Page.getFrameTree");
		const world = await cdp.call("Page.createIsolatedWorld", {
			frameId: tree.frameTree.frame.id,
			worldName: "laplace-credential-fill",
		});
		const result = await cdp.call("Runtime.evaluate", {
			contextId: world.executionContextId,
			returnByValue: true,
			expression: `(() => {
				if (location.origin !== ${JSON.stringify(target.origin)} || window !== window.top) return {filled:0};
				const values = ${JSON.stringify(values)};
				const selectors = {username:'input[autocomplete="username"],input[type="email"]',password:'input[type="password"]',totp:'input[autocomplete="one-time-code"]'};
				const fields = [];
				for (const [key,value] of Object.entries(values)) {
					const matches = [...document.querySelectorAll(selectors[key])].filter(el => !el.disabled && !el.readOnly && el.getClientRects().length);
					if (matches.length !== 1) return {filled:0};
					const el = matches[0];
					if (el.form && new URL(el.form.action || location.href,location.href).origin !== location.origin) return {filled:0};
					fields.push([el,value]);
				}
				if (location.origin !== ${JSON.stringify(target.origin)}) return {filled:0};
				for (const [el,value] of fields) Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);
				for (const [el] of fields) { el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
				return {filled:fields.length};
			})()`,
		});
		const filled = result?.exceptionDetails ? 0 : result?.result?.value?.filled;
		if (filled !== Object.keys(values).length)
			throw new Error("No unambiguous eligible login fields; fill was not confirmed");
		return { filledFields: filled as number, origin: target.origin };
	} finally {
		cdp.close();
	}
}
