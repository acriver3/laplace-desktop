import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** True on external power; machines without a battery report AC. Unknown counts as battery. */
export async function onExternalPower(): Promise<boolean> {
	try {
		if (process.platform === "darwin") {
			const { stdout } = await execute("/usr/bin/pmset", ["-g", "ps"], { timeout: 3000 });
			return stdout.includes("'AC Power'");
		}
		if (process.platform === "win32") {
			const { stdout } = await execute(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus",
				],
				{ timeout: 10_000, windowsHide: true },
			);
			return stdout.trim() === "Online";
		}
		const base = "/sys/class/power_supply";
		let battery = false;
		for (const name of await readdir(base)) {
			const type = (await readFile(join(base, name, "type"), "utf8")).trim();
			if (type === "Mains" && (await readFile(join(base, name, "online"), "utf8")).trim() === "1")
				return true;
			if (type === "Battery") battery = true;
		}
		return !battery;
	} catch {
		return false;
	}
}

/** Holds an idle-sleep assertion only; explicit sleep, lid closure, and screen lock still apply. */
function holdAssertion(pid = process.pid): ChildProcess | undefined {
	const options = { stdio: "ignore" as const, windowsHide: true };
	if (process.platform === "darwin")
		return spawn("/usr/bin/caffeinate", ["-i", "-w", String(pid)], options);
	if (process.platform === "win32")
		return spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$s='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; $t=Add-Type -MemberDefinition $s -Name P -Namespace Laplace -PassThru; $null=$t::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ${pid}`,
			],
			options,
		);
	return spawn(
		"systemd-inhibit",
		[
			"--what=idle",
			"--who=Laplace Runtime",
			"--why=Shared connectors are available to remote AI clients",
			"--mode=block",
			"tail",
			`--pid=${pid}`,
			"-f",
			"/dev/null",
		],
		options,
	);
}

/** Keeps the computer awake only while enabled, sharing remotely, and on external power. */
export class KeepAwake {
	private child?: ChildProcess;
	private timer?: ReturnType<typeof setInterval>;
	private checking = false;
	constructor(
		private wanted: () => boolean,
		private power = onExternalPower,
		private hold = holdAssertion,
	) {}
	get active() {
		return !!this.child;
	}
	start(interval = 60_000) {
		this.timer = setInterval(() => void this.update(), interval);
		this.timer.unref();
		void this.update();
	}
	async update() {
		if (this.checking) return;
		this.checking = true;
		try {
			const hold = this.wanted() && (await this.power());
			if (hold && !this.child) {
				const child = this.hold();
				child?.on("error", () => {
					if (this.child === child) this.child = undefined;
				});
				child?.on("exit", () => {
					if (this.child === child) this.child = undefined;
				});
				this.child = child;
			} else if (!hold) this.release();
		} finally {
			this.checking = false;
		}
	}
	release() {
		const child = this.child;
		this.child = undefined;
		child?.kill();
	}
	stop() {
		clearInterval(this.timer);
		this.release();
	}
}
