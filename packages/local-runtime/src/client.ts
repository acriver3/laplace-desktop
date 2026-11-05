import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
	LOCAL_RUNTIME_PROTOCOL,
	localRuntimeDescriptor,
	localRuntimeDescriptorFile,
	type LocalRuntimeDescriptor,
} from "@repo/project-protocol/local-runtime";

import type { DesktopSnapshot, HelperEvent, HelperMethod } from "./shared/helper-contracts";
import { helperEnvironment } from "./environment";

export async function readRuntimeDescriptor(root: string) {
	try {
		const descriptor = localRuntimeDescriptor.parse(
			JSON.parse(await readFile(join(root, localRuntimeDescriptorFile), "utf8")),
		);
		process.kill(descriptor.pid, 0);
		return descriptor;
	} catch {
		return undefined;
	}
}

/** Desktop's connection to the background Laplace Runtime; quitting Desktop leaves it running. */
export class RuntimeClient {
	private descriptor?: LocalRuntimeDescriptor;
	private events?: AbortController;
	private ready = false;
	private stopping = false;
	snapshot?: DesktopSnapshot;
	constructor(
		private event: (event: HelperEvent) => void,
		private failed: (message: string) => void,
	) {}
	async start(root: string, resources: string, origin: string, helperPath: string) {
		this.stopping = false;
		let descriptor = await readRuntimeDescriptor(root);
		if (!descriptor) {
			const node = join(resources, "runtimes", process.platform === "win32" ? "node.exe" : "node");
			const child = spawn(
				node,
				[
					join(dirname(helperPath), "service.cjs"),
					"--root",
					root,
					"--resources",
					resources,
					"--origin",
					origin,
				],
				{ detached: true, stdio: "ignore", windowsHide: true, env: helperEnvironment() },
			);
			child.on("error", () => {});
			child.unref();
			for (let attempt = 0; attempt < 80 && !descriptor; attempt++) {
				if (child.exitCode !== null)
					throw new Error(
						"Laplace Runtime could not initialize. Check that the system keychain is available.",
					);
				await delay(250);
				descriptor = await readRuntimeDescriptor(root);
			}
			if (!descriptor)
				throw new Error("Laplace Runtime did not start. Check its runtime installation.");
		}
		if (descriptor.protocol !== LOCAL_RUNTIME_PROTOCOL)
			throw new Error("Laplace Runtime needs an update before Desktop can connect.");
		this.descriptor = descriptor;
		await this.subscribe(descriptor);
	}
	private headers(descriptor: LocalRuntimeDescriptor) {
		return {
			Authorization: `Bearer ${descriptor.token}`,
			"Laplace-Runtime-Protocol": String(LOCAL_RUNTIME_PROTOCOL),
		};
	}
	private async subscribe(descriptor: LocalRuntimeDescriptor) {
		const controller = new AbortController();
		this.events = controller;
		const response = await fetch(new URL("events", descriptor.control), {
			headers: this.headers(descriptor),
			signal: controller.signal,
		});
		if (!response.ok || !response.body)
			throw new Error("Laplace Runtime refused the Desktop connection.");
		this.ready = true;
		void this.read(response.body, controller).finally(() => {
			if (this.events !== controller) return;
			this.events = undefined;
			this.ready = false;
			if (!this.stopping)
				this.failed(
					"Laplace Runtime stopped. Start it again to reconnect; calls have not been replayed.",
				);
		});
		this.event({ event: "ready" });
	}
	private async read(body: ReadableStream<Uint8Array>, controller: AbortController) {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				let boundary: number;
				while ((boundary = buffer.indexOf("\n\n")) >= 0) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					if (!frame.startsWith("data: ")) continue;
					const event = JSON.parse(frame.slice(6)) as HelperEvent;
					if (event.event === "snapshot") this.snapshot = event.data;
					this.event(event);
				}
			}
		} catch {
			/* Abort or a closed runtime both end the subscription. */
		} finally {
			controller.abort();
		}
	}
	async request<T = unknown>(method: HelperMethod, input: unknown = {}): Promise<T> {
		const descriptor = this.descriptor;
		if (!descriptor || !this.ready)
			throw new Error("Laplace Runtime is unavailable or still starting.");
		let response: Response;
		try {
			response = await fetch(new URL("request", descriptor.control), {
				method: "POST",
				headers: { ...this.headers(descriptor), "Content-Type": "application/json" },
				body: JSON.stringify({ method, input }),
				signal: AbortSignal.timeout(180_000),
			});
		} catch (error) {
			throw new Error(
				(error as Error).name === "TimeoutError"
					? "Local operation timed out. Check its status before retrying."
					: "Laplace Runtime disconnected. In-flight calls were not replayed.",
			);
		}
		if (!response.ok) throw new Error("Laplace Runtime rejected the request.");
		const reply = (await response.json()) as { result: T } | { error: string };
		if ("error" in reply) throw new Error(reply.error);
		return reply.result;
	}
	/** Disconnects this Desktop instance; the runtime keeps serving AI clients. */
	async stop() {
		this.stopping = true;
		this.ready = false;
		const events = this.events;
		this.events = undefined;
		events?.abort();
		this.descriptor = undefined;
	}
	/** Explicit user stop: ends connector processes and relay access for this profile. */
	async shutdown() {
		const descriptor = this.descriptor;
		if (!descriptor) return;
		await this.request("shutdown").catch(() => {});
		await this.stop();
		for (let attempt = 0; attempt < 60; attempt++) {
			try {
				process.kill(descriptor.pid, 0);
			} catch {
				return;
			}
			await delay(250);
		}
	}
}
