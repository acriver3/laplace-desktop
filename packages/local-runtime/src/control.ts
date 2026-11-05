import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	LOCAL_RUNTIME_PROTOCOL,
	localRuntimeDescriptor,
	localRuntimeDescriptorFile,
	type LocalRuntimeDescriptor,
} from "@repo/project-protocol/local-runtime";

import type { HelperMethod } from "./shared/helper-contracts";

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

export const controlHeaders = (descriptor: LocalRuntimeDescriptor) => ({
	Authorization: `Bearer ${descriptor.token}`,
	"Laplace-Runtime-Protocol": String(LOCAL_RUNTIME_PROTOCOL),
});
/** One management call; used by Desktop, the CLI, and lifecycle commands. */
export async function controlRequest<T = unknown>(
	descriptor: LocalRuntimeDescriptor,
	method: HelperMethod,
	input: unknown = {},
	timeout = 180_000,
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(new URL("request", descriptor.control), {
			method: "POST",
			headers: { ...controlHeaders(descriptor), "Content-Type": "application/json" },
			body: JSON.stringify({ method, input }),
			signal: AbortSignal.timeout(timeout),
		});
	} catch (error) {
		throw new Error(
			(error as Error).name === "TimeoutError"
				? "Local operation timed out. Check its status before retrying."
				: "Laplace Runtime disconnected. In-flight calls were not replayed.",
		);
	}
	if (response.status === 409)
		throw new Error("Laplace Runtime and this client need matching updates.");
	if (!response.ok) throw new Error("Laplace Runtime rejected the request.");
	const reply = (await response.json()) as { result: T } | { error: string };
	if ("error" in reply) throw new Error(reply.error);
	return reply.result;
}
