import { configurationEventSchema, connectorOriginSchema } from "@repo/project-protocol/local-mcp";
import { WebSocket } from "ws";
export { WebSocket } from "ws";

export class LocalApiError extends Error {
	constructor(readonly status: number) {
		super(
			"Laplace authorization unavailable or access denied. Execution is blocked; check local status.",
		);
	}
}
export class LocalApi {
	readonly origin: string;
	constructor(
		origin: string,
		private credential?: string,
	) {
		this.origin = connectorOriginSchema.parse(origin);
	}
	async post(
		path:
			| "portable-sync"
			| "portable-inventory"
			| "portable-source"
			| "portable-access"
			| "portable-artifact"
			| "portable-upload"
			| "portable-authorize"
			| "start"
			| "poll"
			| "configuration"
			| "discovery"
			| "authorize"
			| "heartbeat"
			| "sync"
			| "snapshot"
			| "keepalive"
			| "remove"
			| "credentials/poll"
			| "credentials/authorize"
			| "credentials/result"
			| "revoke",
		body: unknown,
	) {
		const response = await fetch(`${this.origin}/api/local-mcp/${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(this.credential ? { Authorization: `Bearer ${this.credential}` } : {}),
			},
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new LocalApiError(response.status);
		return response.json();
	}
	/** One authenticated, metadata-only connection. Only HTTP 404 signals an older server. */
	watch(
		invalidate: () => void,
		disconnected: () => void,
		signal: AbortSignal,
	): Promise<ConfigurationWatch> {
		return new Promise((resolve, reject) => {
			const url = new URL("/api/local-mcp/events", this.origin);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(url, {
				headers: { Authorization: `Bearer ${this.credential ?? ""}` },
				followRedirects: false,
				handshakeTimeout: 10_000,
				maxPayload: 1024,
			});
			let ready = false,
				closed = false;
			const timer = setTimeout(() => fail(), 10_000);
			timer.unref();
			const stop = () => {
				if (closed) return;
				closed = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				socket.terminate();
			};
			const fail = (error: Error = new LocalApiError(503)) => {
				if (closed) return;
				stop();
				if (ready) disconnected();
				else reject(error);
			};
			const abort = () => fail();
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				fail();
				return;
			}
			socket.on("unexpected-response", (_request, response) => {
				response.resume();
				fail(new LocalApiError(response.statusCode ?? 503));
			});
			socket.on("error", () => fail());
			socket.on("close", () => fail());
			socket.on("message", (data, binary) => {
				if (closed) return;
				try {
					if (binary) throw new Error("Invalid event");
					const text = Array.isArray(data)
						? Buffer.concat(data).toString("utf8")
						: data instanceof ArrayBuffer
							? Buffer.from(data).toString("utf8")
							: data.toString("utf8");
					if (text === "pong" && ready) return;
					const event = configurationEventSchema.parse(JSON.parse(text));
					if (!ready) {
						if (event.type !== "ready") throw new Error("Invalid subscription");
						ready = true;
						clearTimeout(timer);
						resolve({
							isOpen: () => !closed && socket.readyState === WebSocket.OPEN,
							ping: () => {
								if (!closed && socket.readyState === WebSocket.OPEN) socket.send("ping");
							},
							close: stop,
						});
					} else if (event.type === "invalidate") invalidate();
					else if (event.type === "revoked") fail(new LocalApiError(403));
					else throw new Error("Invalid event");
				} catch {
					fail();
				}
			});
		});
	}
}

export interface ConfigurationWatch {
	isOpen(): boolean;
	ping(): void;
	close(): void;
}
