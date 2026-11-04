import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { minimalEnvironment } from "@repo/local-mcp-core/config";
import { spawnLocal, stopTree } from "@repo/local-mcp-core/process";
import type { CredentialAction } from "@repo/project-protocol/credentials";

import { bitwardenError, CredentialSetupError } from "./credential-errors";

const MAX_OUTPUT = 65536;
/** CLI output is private to this module. Never forward stderr or errors from child processes. */
export async function bitwardenCommand(
	path: string,
	args: string[],
	session: string | undefined,
	signal: AbortSignal,
	master?: string,
	options?: { args?: string[]; appData?: string },
): Promise<string> {
	return new Promise((resolve, reject) => {
		const env = minimalEnvironment(homedir(), {});
		if (session) env.BW_SESSION = session;
		if (master !== undefined) env.LAPLACE_BW_MASTER = master;
		if (options?.appData) env.BITWARDENCLI_APPDATA_DIR = options.appData;
		const child = spawn(path, [...(options?.args ?? []), ...args, "--nointeraction"], {
			shell: false,
			windowsHide: true,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let failed = false;
		let diagnostic = "";
		const fail = () => {
			if (failed) return;
			failed = true;
			child.kill();
			reject(signal.aborted ? new CredentialSetupError("cancelled") : bitwardenError(diagnostic));
		};
		const timeout = setTimeout(fail, 30000);
		const abort = () => fail();
		signal.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 8_388_608) fail();
			else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			diagnostic = (diagnostic + chunk.toString()).slice(-8192);
		});
		child.on("error", () => {
			diagnostic = "Bitwarden unavailable";
			if (!failed) {
				failed = true;
				reject(new CredentialSetupError("unavailable"));
			}
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			if (!failed && code === 0) resolve(Buffer.concat(chunks).toString());
			else {
				diagnostic += Buffer.concat(chunks).toString().slice(-8192);
				fail();
			}
		});
		if (signal.aborted) fail();
	});
}

export function validateParameters(action: CredentialAction, values: Record<string, string>) {
	if (
		Object.keys(values).length !== Object.keys(action.parameters).length ||
		Object.entries(action.parameters).some(([key, allowed]) => !allowed.includes(values[key]))
	)
		throw new Error("Parameters must match the configured choices");
}
export function substitute(value: string, parameters: Record<string, string>) {
	return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, name: string) => {
		if (!Object.hasOwn(parameters, name)) throw new Error("Unknown action parameter");
		return parameters[name];
	});
}

export function selectedResult(
	raw: string,
	fields: string[],
	secrets: string[],
): Record<string, string | number | boolean | null> {
	if (!fields.length) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const result: Record<string, string | number | boolean | null> = {};
	const variants = secrets
		.filter(Boolean)
		.flatMap((s) => [
			s,
			encodeURIComponent(s),
			Buffer.from(s).toString("base64"),
			Buffer.from(s).toString("hex"),
			JSON.stringify(s).slice(1, -1),
		]);
	for (const key of fields) {
		const value: unknown = (parsed as Record<string, unknown>)[key];
		if (value !== null && !["string", "boolean", "number"].includes(typeof value)) continue;
		const text = String(value);
		if (
			text.length > 2000 ||
			variants.some((secret) => text.includes(secret) || key.includes(secret))
		)
			continue;
		Object.defineProperty(result, key, { value, enumerable: true });
	}
	return result;
}

/** Conservative public IPv4 egress only; pin the checked address in the actual TLS request. */
export function publicV4(ip: string) {
	const p = ip.split(".").map(Number);
	if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
	const [a, b] = p;
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && [0, 168].includes(b)) ||
		(a === 198 && [18, 19, 51].includes(b)) ||
		(a === 203 && b === 0)
	);
}

export async function executeHttp(
	action: Extract<CredentialAction, { kind: "http" }>,
	parameters: Record<string, string>,
	value: string,
	signal: AbortSignal,
) {
	const url = new URL(action.url);
	const addresses = await lookup(url.hostname, { all: true, family: 4 });
	if (!addresses.length || addresses.some((a) => !publicV4(a.address)))
		throw new Error("API destination is not public HTTPS");
	signal.throwIfAborted();
	const body = action.body
		? JSON.stringify(
				Object.fromEntries(
					Object.entries(action.body).map(([k, v]) => [k, substitute(v, parameters)]),
				),
			)
		: undefined;
	return new Promise<{ status: number; fields: Record<string, unknown> }>((resolve, reject) => {
		const req = request(
			url,
			{
				method: action.method,
				family: 4,
				signal,
				lookup: (_host, _options, callback) => callback(null, addresses[0].address, 4),
				headers: {
					[action.header]: action.prefix + value,
					...(body
						? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
						: {}),
				},
			},
			(response) => {
				let bytes = 0;
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > MAX_OUTPUT) req.destroy(new Error("Response limit"));
					else chunks.push(chunk);
				});
				response.on("error", () => reject(new Error("API request failed; outcome may be unknown")));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						fields: selectedResult(Buffer.concat(chunks).toString(), action.resultFields, [
							value,
							action.prefix + value,
						]),
					}),
				);
			},
		);
		req.on("error", () => reject(new Error("API request failed; outcome may be unknown")));
		req.setTimeout(30000, () => req.destroy());
		req.end(body);
	});
}

export async function executeCommand(
	action: Extract<CredentialAction, { kind: "command" }>,
	parameters: Record<string, string>,
	values: Record<string, string>,
	resources: string,
	signal: AbortSignal,
) {
	if (!isAbsolute(action.executable) || !isAbsolute(action.cwd))
		throw new Error("Configured commands require absolute executable and working-directory paths");
	const args = action.args.map((arg) => substitute(arg, parameters));
	return new Promise<{ exitCode: number | null; fields: Record<string, unknown> }>(
		(resolve, reject) => {
			const child = spawnLocal(
				action.executable,
				args,
				action.cwd,
				minimalEnvironment(action.cwd, values),
				resources,
			);
			let bytes = 0,
				failed = false;
			const chunks: Buffer[] = [];
			const abort = () => {
				failed = true;
				void stopTree(child);
				reject(new Error("Command interrupted; outcome may be unknown"));
			};
			signal.addEventListener("abort", abort, { once: true });
			child.stdin.end();
			child.stderr.resume();
			child.stdout.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > MAX_OUTPUT) abort();
				else chunks.push(chunk);
			});
			child.on("error", abort);
			child.on("close", (code) => {
				signal.removeEventListener("abort", abort);
				if (!failed)
					resolve({
						exitCode: code,
						fields: selectedResult(
							Buffer.concat(chunks).toString(),
							action.resultFields,
							Object.values(values),
						),
					});
			});
			if (signal.aborted) abort();
		},
	);
}
