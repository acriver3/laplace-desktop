import { join, dirname } from "node:path";

import { z } from "zod";

import { helperRequest, type HelperEvent, type HelperReply } from "../shared/helper-contracts";
import { createRuntime } from "./runtime";

/** Legacy host: Electron owns the runtime lifetime through an IPC channel. */
export async function startHelper() {
	if (!process.send || !process.connected)
		throw new Error("The desktop helper must be launched by Laplace Desktop");
	const send = (message: HelperEvent | HelperReply) => {
		if (process.connected) process.send?.(message, () => {});
	};
	const runtime = await createRuntime({
		root: z.string().min(1).parse(process.env.LAPLACE_DESKTOP_ROOT),
		resources: z.string().min(1).parse(process.env.LAPLACE_DESKTOP_RESOURCES),
		origin: process.env.LAPLACE_DESKTOP_ORIGIN ?? "https://connect.withlaplace.com",
		bridgePath: join(dirname(process.argv[1]!), "bridge.cjs"),
		emit: send,
	});
	const stop = async () => {
		clearInterval(parentWatch);
		await runtime.stop();
		if (process.connected) process.disconnect?.();
	};
	const parent = process.ppid;
	const parentWatch = setInterval(() => {
		try {
			process.kill(parent, 0);
			if (process.ppid !== parent) void stop();
		} catch {
			void stop();
		}
	}, 1000);
	parentWatch.unref();
	process.once("disconnect", () => void stop());
	process.once("SIGTERM", () => void stop());
	process.once("SIGINT", () => void stop());
	process.on("message", (raw: unknown) => {
		void (async () => {
			const parsed = helperRequest.safeParse(raw);
			if (!parsed.success) return;
			const { id, method, input } = parsed.data;
			const { changed, shutdown, ...reply } = await runtime.handle(method, input);
			send({ id, ...reply } as HelperReply);
			if (shutdown) await stop();
			else if (changed) send({ event: "snapshot", data: runtime.snapshot() });
		})();
	});
	const { manager, hosted, server } = runtime;
	if (!process.connected) {
		await stop();
		return { manager, hosted, server, stop };
	}
	send({ event: "snapshot", data: runtime.snapshot() });
	send({ event: "ready" });
	void hosted.restore().catch(() => {});
	return { manager, hosted, server, stop };
}
if (process.argv[1]?.endsWith("main.cjs") || process.argv[1]?.endsWith("main.ts"))
	void startHelper().catch(() => {
		process.stderr.write(
			"Laplace Desktop manager initialization failed. Check its keychain, runtime, and profile lock.\n",
		);
		process.exitCode = 1;
		process.disconnect?.();
	});
