import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

export const nativeWindow = z.object({
	window: z.string().regex(/^\d+$/),
	pid: z.number().int().positive(),
	version: z.string().min(1).max(100),
});
export type NativeWindow = z.infer<typeof nativeWindow>;
export const nativeObservation = z.object({
	composer: z.boolean(),
	editor: z.boolean(),
	permission: z.boolean().optional(),
	attachments: z.number().int().nonnegative(),
	annotations: z.number().int().nonnegative(),
	stage: z.boolean(),
});
export type NativeObservation = z.infer<typeof nativeObservation>;
export type NativeOperation =
	| "identify"
	| "copy-link"
	| "open-tab"
	| "navigate"
	| "annotate"
	| "observe"
	| "stage"
	| "focus-composer"
	| "focus-annotation"
	| "paste-image";

/** Fixed operations only. Never expose the adapter as a general computer-use tool. */
export class PointNative {
	readonly executable: string;
	constructor(
		resources: string,
		readonly platform = process.platform,
	) {
		this.executable = join(
			resources,
			"point",
			platform === "win32" ? "point-native.exe" : "point-native",
		);
	}
	async available() {
		if (!["win32", "darwin"].includes(this.platform)) return false;
		try {
			await access(this.executable);
			return true;
		} catch {
			return false;
		}
	}
	async call(operation: NativeOperation, target?: NativeWindow): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				this.executable,
				[operation, ...(target ? [target.window, String(target.pid)] : [])],
				{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
			);
			let output = "",
				settled = false;
			const finish = (error?: Error, value?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve(value);
			};
			const timer = setTimeout(() => {
				child.kill();
				finish(
					new Error(
						"Codex did not respond. Your snip is retained; check the draft before retrying.",
					),
				);
			}, 8000);
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
				if (output.length > 8192) {
					child.kill();
					finish(new Error("Unexpected Codex adapter response."));
				}
			});
			child.once("error", () =>
				finish(new Error("Point’s native adapter could not start. Reinstall this Desktop build.")),
			);
			child.once("close", (code) => {
				try {
					const result = JSON.parse(output);
					if (code !== 0 || result.error)
						finish(
							new Error(typeof result.error === "string" ? result.error : "Codex handoff failed."),
						);
					else finish(undefined, result);
				} catch {
					finish(new Error("Codex handoff did not return a verified result."));
				}
			});
		});
	}
	async identify() {
		return nativeWindow.parse(await this.call("identify"));
	}
	async observe(target: NativeWindow) {
		return nativeObservation.parse(await this.call("observe", target));
	}
}
