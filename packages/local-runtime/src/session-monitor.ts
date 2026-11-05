import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type SessionEvent = "lock" | "resume";

/** Screen-lock state from OS tools; undefined when the platform gives no trustworthy reading. */
export async function screenLocked(): Promise<boolean | undefined> {
	try {
		if (process.platform === "darwin") {
			const { stdout } = await execute("/usr/sbin/ioreg", ["-n", "Root", "-d1", "-a"], {
				timeout: 3000,
				maxBuffer: 1024 * 1024,
			});
			return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(stdout);
		}
		if (process.platform === "win32") {
			const { stdout } = await execute(
				"tasklist.exe",
				["/FI", "IMAGENAME eq LogonUI.exe", "/FO", "CSV", "/NH"],
				{ timeout: 5000, maxBuffer: 100_000, windowsHide: true },
			);
			return /"LogonUI\.exe"/i.test(stdout);
		}
		if (process.platform === "linux" && process.env.XDG_SESSION_ID) {
			const { stdout } = await execute(
				"loginctl",
				["show-session", process.env.XDG_SESSION_ID, "-p", "LockedHint", "--value"],
				{ timeout: 3000, maxBuffer: 10_000 },
			);
			return stdout.trim() === "yes";
		}
	} catch {
		/* Missing tools leave locking to sleep detection and explicit user action. */
	}
	return undefined;
}

/**
 * Runtime-owned replacement for Desktop's powerMonitor hooks. A suspended process cannot run,
 * so a large timer gap is treated as sleep: lock first, then resume browser recovery.
 */
export function watchSession(
	onEvent: (event: SessionEvent) => void,
	options: {
		interval?: number;
		probe?: () => Promise<boolean | undefined>;
		now?: () => number;
	} = {},
) {
	const interval = options.interval ?? 5000;
	const probe = options.probe ?? screenLocked;
	const now = options.now ?? Date.now;
	let last = now();
	let locked = false;
	let probing = false;
	const tick = async () => {
		const current = now();
		const gap = current - last;
		last = current;
		if (gap > interval * 6) {
			onEvent("lock");
			onEvent("resume");
		}
		if (probing) return;
		probing = true;
		try {
			const value = await probe();
			if (value && !locked) onEvent("lock");
			if (value !== undefined) locked = value;
		} finally {
			probing = false;
		}
	};
	const timer = setInterval(() => void tick().catch(() => {}), interval);
	timer.unref();
	return { stop: () => clearInterval(timer), tick };
}
