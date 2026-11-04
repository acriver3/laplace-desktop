interface ToolResult {
	structuredContent?: unknown;
	_meta?: Record<string, unknown>;
	isError?: boolean;
	content?: { type: string; text?: string }[];
}
type Listener = (result: ToolResult) => void;
let nextId = 0;
const pending = new Map<
	number,
	{
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}
>();
const listeners = new Set<Listener>();
let latest: ToolResult | undefined;
export function request<T = unknown>(method: string, params: unknown): Promise<T> {
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(
			() => {
				pending.delete(id);
				reject(new Error("The host did not respond. Refresh or reconnect Laplace."));
			},
			method === "tools/call" ? 115_000 : 15_000,
		);
		pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
		window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
	});
}
function notify(method: string, params: unknown) {
	window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
}
function hostContext(context?: { theme?: string }) {
	if (context?.theme === "dark" || context?.theme === "light") {
		document.documentElement.dataset.theme = context.theme;
		document.documentElement.classList.toggle("dark", context.theme === "dark");
	}
}
window.addEventListener("message", (event) => {
	if (event.source !== window.parent || !event.data || event.data.jsonrpc !== "2.0") return;
	const message = event.data;
	if (typeof message.id === "number" && pending.has(message.id)) {
		const task = pending.get(message.id)!;
		pending.delete(message.id);
		clearTimeout(task.timer);
		if (message.error)
			task.reject(new Error(message.error.message ?? "The host rejected this request"));
		else task.resolve(message.result);
	} else if (message.method === "ui/notifications/tool-result") {
		latest = message.params;
		for (const listener of listeners) listener(message.params);
	} else if (message.method === "ui/notifications/host-context-changed")
		hostContext(message.params);
});
const ready = request<{ hostContext?: { theme?: string } }>("ui/initialize", {
	appInfo: { name: document.title || "Laplace", version: "1.0.0" },
	appCapabilities: {},
	protocolVersion: "2026-01-26",
}).then((result) => {
	hostContext(result.hostContext);
	notify("ui/notifications/initialized", {});
	new ResizeObserver(() =>
		notify("ui/notifications/size-changed", { height: document.documentElement.scrollHeight }),
	).observe(document.body);
});
// Consumers surface failures; avoid an unhandled rejection while the first result is loading.
void ready.catch(() => undefined);
export function subscribe(listener: Listener) {
	listeners.add(listener);
	if (latest) listener(latest);
	return () => {
		listeners.delete(listener);
	};
}
export class ToolCallError extends Error {}
export async function callTool(name: string, args: unknown) {
	await ready;
	const result = await request<ToolResult>("tools/call", { name, arguments: args });
	if (result.isError) {
		const text = result.content?.find((item) => item.type === "text")?.text;
		let message = text ?? "Laplace could not complete this request";
		try {
			message = JSON.parse(message).error ?? message;
		} catch {
			/* Plain text tool errors are valid. */
		}
		throw new ToolCallError(message);
	}
	return result;
}
export async function openLink(url: string) {
	await ready;
	await request("ui/open-link", { url });
}
export async function askWithContext(text: string, context: unknown) {
	await ready;
	await request("ui/update-model-context", {
		content: [{ type: "text", text: JSON.stringify(context) }],
	});
	await request("ui/message", { role: "user", content: [{ type: "text", text }] });
}
