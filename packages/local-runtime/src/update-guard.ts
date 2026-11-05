import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

export const updateRoot = () => join(homedir(), ".laplace-desktop-updates");

export class UpdateError extends Error {
	constructor(
		public code: "tools" | "network" | "build" | "disk" | "cancelled" | "install" | "invalid",
		message: string,
	) {
		super(message);
	}
}

/** True while a live installer is replacing `application`; launches must wait for it. */
export async function updateLaunchBlocked(application: string, root = updateRoot()) {
	try {
		const marker = z
			.object({ pid: z.number().int().positive(), executable: z.string() })
			.strict()
			.parse(JSON.parse(await readFile(join(root, "installing.json"), "utf8")));
		if (marker.executable !== application) return false;
		process.kill(marker.pid, 0);
		return true;
	} catch {
		return false;
	}
}
