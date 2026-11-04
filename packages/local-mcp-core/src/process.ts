import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, dirname, delimiter } from "node:path";

import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/client";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { MAX_MESSAGE_BYTES } from "@repo/project-protocol/local-mcp";

import { minimalEnvironment } from "./config";

// An independent guardian owns cleanup when the wrapper is killed abruptly.
// It reads only managed process group IDs, never MCP messages or credentials.
let guardian: ChildProcessWithoutNullStreams | undefined;
const groups = new Set<number>();
const guardianSource = `
const readline=require('node:readline');const groups=new Set();
function stop(){for(const pid of groups)try{process.kill(-pid,'SIGKILL')}catch{};process.exit(0)}
readline.createInterface({input:process.stdin}).on('line',line=>{const [op,raw]=line.split(' ');const pid=Number(raw);if(Number.isSafeInteger(pid)&&pid>0){if(op==='add')groups.add(pid);else groups.delete(pid)}}).on('close',stop);
setInterval(()=>{try{process.kill(Number(process.argv[1]),0)}catch{stop()}},500);
`;
function guard(pid: number, active: boolean) {
	if (process.platform === "win32") return;
	if (active) {
		if (!guardian) {
			guardian = spawn(process.execPath, ["-e", guardianSource, String(process.pid)], {
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: {},
			});
			guardian.stdout.resume();
			guardian.stderr.resume();
			guardian.stdin.on("error", () => {});
			guardian.unref();
		}
		groups.add(pid);
		guardian.stdin.write(`add ${pid}\n`);
	} else {
		groups.delete(pid);
		guardian?.stdin.write(`remove ${pid}\n`);
		if (!groups.size && guardian) {
			guardian.stdin.end();
			guardian = undefined;
		}
	}
}
let tracked: (pid: number, active: boolean) => void = () => {};
export function trackProcesses(callback: typeof tracked) {
	tracked = callback;
}
export function spawnLocal(
	command: string,
	args: string[],
	cwd: string,
	env: Record<string, string>,
	resources: string,
): ChildProcessWithoutNullStreams {
	const executable =
		process.platform === "win32" ? join(resources, "runtimes", "process-host.exe") : command;
	const argv = process.platform === "win32" ? [String(process.pid), command, ...args] : args;
	const child = spawn(executable, argv, {
		cwd,
		env,
		shell: false,
		detached: process.platform !== "win32",
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.on("spawn", () => {
		if (child.pid) {
			guard(child.pid, true);
			tracked(child.pid, true);
		}
	});
	child.on("close", () => {
		void stopTree(child).finally(() => {
			if (child.pid) {
				guard(child.pid, false);
				tracked(child.pid, false);
			}
		});
	});
	return child;
}
export async function stopTree(child: ChildProcessWithoutNullStreams) {
	if (!child.pid) return;
	if (process.platform === "win32") {
		// The wrapper holds a kill-on-close Job Object. Killing it also kills
		// descendants even when the MCP process has already exited.
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				child.removeListener("close", done);
				resolve();
			};
			const timer = setTimeout(done, 3000);
			child.once("close", done);
			child.kill();
		});
	} else {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 350));
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* already stopped */
		}
	}
}
export class ManagedStdio implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;
	child?: ChildProcessWithoutNullStreams;
	private buffer = "";
	private closing?: Promise<void>;
	constructor(
		private options: {
			command: string;
			args: string[];
			cwd: string;
			home: string;
			env: Record<string, string>;
			resources: string;
			diagnostic: (message: string) => void;
		},
	) {}
	async start() {
		if (this.child) throw new Error("Already started");
		const child = spawnLocal(
			this.options.command,
			this.options.args,
			this.options.cwd,
			{
				...minimalEnvironment(this.options.home, this.options.env),
				PATH: [
					join(this.options.resources, "runtimes"),
					dirname(process.execPath),
					this.options.env.PATH ?? process.env.PATH ?? "",
				].join(delimiter),
			},
			this.options.resources,
		);
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.buffer += chunk;
			if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
				this.onerror?.(new Error("MCP message exceeds limit"));
				void this.close();
				return;
			}
			let newline: number;
			while ((newline = this.buffer.indexOf("\n")) !== -1) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				try {
					this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
				} catch {
					this.onerror?.(new Error("Invalid MCP stdout"));
				}
			}
		});
		// Stderr is local-only. Never include input/result/stdout or exception
		// bodies in cloud telemetry. Cap each local diagnostic chunk.
		child.stderr.on("data", (chunk: Buffer) =>
			this.options.diagnostic(chunk.toString("utf8").slice(0, 4000)),
		);
		child.on("error", () => this.onerror?.(new Error("Unable to start executable")));
		child.on("close", () => {
			void stopTree(child);
			this.onclose?.();
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
	}
	async send(message: JSONRPCMessage) {
		const child = this.child;
		if (!child || !child.stdin.writable) throw new Error("MCP process stopped");
		await new Promise<void>((resolve, reject) =>
			child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
				error ? reject(error) : resolve(),
			),
		);
	}
	async close() {
		if (this.closing) return this.closing;
		const child = this.child;
		if (child) {
			this.child = undefined;
			this.closing = stopTree(child);
			await this.closing;
		}
	}
}
