import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
	DesktopSnapshot,
	HelperEvent,
	HelperMethod,
	HelperReply,
} from "../shared/helper-contracts";

export class HelperClient {
	private child?: ChildProcess;
	private ready = false;
	private stopping = false;
	private pending = new Map<
		string,
		{
			resolve(value: unknown): void;
			reject(error: Error): void;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();
	snapshot?: DesktopSnapshot;
	constructor(
		private event: (event: HelperEvent) => void,
		private failed: (message: string) => void,
	) {}
	async start(root: string, resources: string, origin: string, helperPath: string) {
		const node = join(resources, "runtimes", process.platform === "win32" ? "node.exe" : "node");
		const env: NodeJS.ProcessEnv = {};
		for (const key of [
			"PATH",
			"Path",
			"HOME",
			"USERPROFILE",
			"APPDATA",
			"LOCALAPPDATA",
			"SystemRoot",
			"WINDIR",
			"TEMP",
			"TMP",
			"TMPDIR",
			"LANG",
			"LC_ALL",
			"LAPLACE_BROWSER_CONNECTION_ENABLED",
		])
			if (process.env[key]) env[key] = process.env[key];
		Object.assign(env, {
			LAPLACE_DESKTOP_ROOT: root,
			LAPLACE_DESKTOP_RESOURCES: resources,
			LAPLACE_DESKTOP_ORIGIN: origin,
		});
		const child = spawn(node, [helperPath], {
			env,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			windowsHide: true,
		});
		this.child = child;
		this.ready = false;
		this.stopping = false;
		let ready = false;
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("Local MCP manager did not start. Check its runtime installation."));
				child.kill();
			}, 20_000);
			child.on("message", (message: unknown) => {
				if (!message || typeof message !== "object") return;
				if ("id" in message) {
					const reply = message as HelperReply;
					const request = this.pending.get(reply.id);
					if (!request) return;
					this.pending.delete(reply.id);
					clearTimeout(request.timeout);
					if ("error" in reply) request.reject(new Error(reply.error));
					else request.resolve(reply.result);
				} else if ("event" in message) {
					const event = message as HelperEvent;
					if (event.event === "ready") {
						ready = true;
						this.ready = true;
						clearTimeout(timer);
						resolve();
					}
					if (event.event === "snapshot") this.snapshot = event.data;
					this.event(event);
				}
			});
			child.once("error", () => {
				clearTimeout(timer);
				reject(
					new Error("The bundled Node runtime could not start. Run the desktop runtime setup."),
				);
			});
			child.once("exit", () => {
				clearTimeout(timer);
				if (this.child === child) {
					this.child = undefined;
					this.ready = false;
					for (const request of this.pending.values()) {
						clearTimeout(request.timeout);
						request.reject(
							new Error("Local MCP manager stopped. In-flight calls were not replayed."),
						);
					}
					this.pending.clear();
					if (ready && !this.stopping)
						this.failed(
							"Local MCP manager stopped. Restart Laplace to reconnect; calls have not been replayed.",
						);
					else
						reject(
							new Error(
								"Local MCP manager could not initialize. Check that the system keychain is available.",
							),
						);
				}
			});
			// Do not surface arbitrary child stderr: connector output can contain credentials.
			child.stderr?.resume();
		});
	}
	request<T = unknown>(method: HelperMethod, input: unknown = {}): Promise<T> {
		return new Promise((resolve, reject) => {
			if (!this.child?.connected || !this.ready) {
				reject(new Error("Local MCP manager is unavailable or still starting."));
				return;
			}
			const id = randomUUID();
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Local operation timed out. Check its status before retrying."));
			}, 180_000);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
			this.child.send({ id, method, input }, (error) => {
				if (error) {
					clearTimeout(timeout);
					this.pending.delete(id);
					reject(new Error("Local MCP manager disconnected."));
				}
			});
		});
	}
	async stop() {
		const child = this.child;
		if (!child) return;
		this.stopping = true;
		const exited = new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve();
				return;
			}
			const force = setTimeout(() => child.kill("SIGKILL"), 12_000);
			const terminate = setTimeout(() => child.kill(), 10_000);
			child.once("exit", () => {
				clearTimeout(force);
				clearTimeout(terminate);
				resolve();
			});
		});
		// The helper acknowledges shutdown before draining processes and leases.
		// Wait for its actual exit; a forced exit still trips process guardians.
		void this.request("shutdown").catch(() => {
			child.kill();
		});
		await exited;
		this.child = undefined;
		this.ready = false;
		for (const request of this.pending.values()) {
			clearTimeout(request.timeout);
			request.reject(new Error("Local MCP manager stopped."));
		}
		this.pending.clear();
	}
}
