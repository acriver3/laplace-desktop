import { createHash } from "node:crypto";

import { WebSocket } from "@repo/local-mcp-core/api";
import { canonicalJson } from "@repo/project-protocol/local-mcp";
import { RELAY_PROTOCOL, relayRequest } from "@repo/project-protocol/portable-connectors";

import type { DesktopManager } from "./manager";
import type { PortableConnectors } from "./portable";
import { desktopVersion } from "./shared/version";

/** Outbound transport only. A reconnect never resends a tool invocation. */
export function startPortableRelay(manager: DesktopManager, portable: PortableConnectors) {
	let socket: WebSocket | undefined,
		stopped = false,
		busy = false,
		lastHeartbeat = 0;
	const calls = new Map<string, AbortController>();
	const uploaded = new Set<string>();
	const close = () => {
		portable.cancelRemote();
		socket?.terminate();
		socket = undefined;
		for (const controller of calls.values()) controller.abort();
		calls.clear();
	};
	const tick = async () => {
		if (stopped || busy) return;
		if (manager.status().mode !== "linked") {
			portable.cancelRemote();
			close();
			return;
		}
		busy = true;
		try {
			if (!socket) {
				const token = await manager.store.credential();
				if (!token) return;
				const url = new URL("/api/local-mcp/relay", manager.status().origin);
				url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
				const ws = new WebSocket(url, {
					headers: {
						Authorization: `Bearer ${token}`,
						// Announces selected-client support; hosted Laplace refuses older relays.
						"Laplace-Relay-Protocol": String(RELAY_PROTOCOL),
					},
					followRedirects: false,
					handshakeTimeout: 10_000,
					maxPayload: 1_048_576,
				});
				socket = ws;
				ws.on("error", () => {
					if (socket === ws) close();
				});
				ws.on("close", () => {
					if (socket === ws) close();
				});
				ws.on("message", (raw) => {
					const text = Buffer.isBuffer(raw)
						? raw.toString("utf8")
						: Array.isArray(raw)
							? Buffer.concat(raw).toString("utf8")
							: Buffer.from(raw).toString("utf8");
					if (text === "pong") return;
					void (async () => {
						const envelope = JSON.parse(text);
						if (envelope.type === "cancel") {
							calls.get(envelope.id)?.abort();
							return;
						}
						if (envelope.type !== "request" || typeof envelope.id !== "string") return;
						const input = relayRequest.parse(envelope.input),
							controller = new AbortController();
						calls.set(envelope.id, controller);
						try {
							if (manager.status().mode !== "linked") throw new Error("Link unavailable");
							let result: unknown;
							if (input.kind === "tools")
								result = await manager.remoteTools(input.localId, input.revision);
							else if (input.kind === "call")
								result = await manager.remoteCall(
									input.localId,
									input.revision,
									input.tool,
									input.input,
									controller.signal,
									{ principal: input.principal, grantRevision: input.grantRevision },
								);
							else if (input.kind === "status")
								result = await portable.remoteStatus(input.operationId);
							else {
								const auth = (await (
									await manager.credentialRelayApi()
								).post("portable-authorize", { operationId: input.operationId })) as {
									authorized: boolean;
									fingerprint: string;
								};
								if (
									!auth.authorized ||
									auth.fingerprint !==
										createHash("sha256").update(canonicalJson(input.command)).digest("hex")
								)
									throw new Error("Management access denied");
								result = await portable.remoteManage(input.operationId, input.command);
							}
							const message = JSON.stringify({ id: envelope.id, result });
							if (Buffer.byteLength(message) > 1_048_576) throw new Error("Response too large");
							ws.send(message);
						} catch {
							if (ws.readyState === WebSocket.OPEN)
								ws.send(JSON.stringify({ id: envelope.id, error: true }));
						} finally {
							calls.delete(envelope.id);
						}
					})().catch(() => {
						if (socket === ws) close();
					});
				});
			}
			if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
			await portable.revalidateRemote();
			if (socket?.readyState === WebSocket.OPEN && Date.now() - lastHeartbeat > 20_000) {
				await manager.refresh();
				await (
					await manager.credentialRelayApi()
				).post("heartbeat", {
					runId: manager.runId,
					client: "laplace-desktop",
					version: desktopVersion,
					connections: manager
						.listServers()
						.filter((s) => s.access?.visible)
						.map((s) => ({
							localId: s.id,
							health: s.status === "paused" ? "needs_attention" : s.status,
						})),
				});
				lastHeartbeat = Date.now();
			}
			for (const item of portable.snapshots()) {
				if (!manager.accessFor(item.id).visible || item.snapshot.bundle.kind !== "custom") continue;
				const sha256 = item.snapshot.bundle.sha256,
					key = `${manager.status().installationId}:${sha256}`;
				if (uploaded.has(key)) continue;
				const bytes = await portable.artifact(sha256);
				const response = (await (
					await manager.credentialRelayApi()
				).post("portable-upload", { sha256 })) as { url: string };
				const result = await fetch(response.url, {
					method: "PUT",
					headers: { "Content-Type": "application/octet-stream" },
					body: new Uint8Array(bytes),
					redirect: "error",
					signal: AbortSignal.timeout(60_000),
				});
				if (result.ok) {
					uploaded.add(key);
					await manager.refresh();
				}
			}
		} catch {
			/* Availability is reflected by the relay; never log credentials or payloads. */
		} finally {
			busy = false;
		}
	};
	const timer = setInterval(() => void tick(), 5000);
	timer.unref();
	const unsubscribe = manager.onChanged(() => {
		if (manager.status().mode !== "linked") {
			portable.cancelRemote();
			close();
		}
	});
	void tick();
	return () => {
		stopped = true;
		clearInterval(timer);
		unsubscribe();
		close();
	};
}
