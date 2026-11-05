import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { readRuntimeDescriptor, controlRequest } from "./control";
import { helperEnvironment } from "./environment";
import { runtimeProfiles, type RuntimeProfile } from "./paths";
import { RuntimeStoppedError } from "./runtime-errors";

export { RuntimeStoppedError };

const execute = promisify(execFile);
export const stoppedMarker = (root: string) => join(root, "stopped.json");

export type StartOptions = {
	root: string;
	node: string;
	service: string;
	resources: string;
	origin: string;
	nativeHost?: boolean;
	/** User-initiated starts clear an explicit stop; AI-client bridges never do. */
	explicit?: boolean;
	timeout?: number;
};
export async function explicitlyStopped(root: string) {
	return readFile(stoppedMarker(root), "utf8").then(
		() => true,
		() => false,
	);
}
async function liveLockOwner(root: string) {
	const pid = Number(await readFile(join(root, "manager.lock"), "utf8").catch(() => "0"));
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
/** Starts one detached runtime for the profile root, or returns the one already running. */
export async function startRuntime(options: StartOptions) {
	const running = await readRuntimeDescriptor(options.root);
	if (running) return running;
	if (await explicitlyStopped(options.root)) {
		if (!options.explicit) throw new RuntimeStoppedError();
		await rm(stoppedMarker(options.root), { force: true });
	}
	// A descriptor left by a dead process means the runtime was terminated, not cleanly stopped.
	const descriptor = join(options.root, "runtime.json");
	if (
		await readFile(descriptor).then(
			() => true,
			() => false,
		)
	) {
		if (!options.explicit) throw new RuntimeStoppedError(true);
		await rm(descriptor, { force: true });
	}
	const child = spawn(
		options.node,
		[
			options.service,
			"--root",
			options.root,
			"--resources",
			options.resources,
			"--origin",
			options.origin,
			...(options.nativeHost ? ["--native-host"] : []),
		],
		{ detached: true, stdio: "ignore", windowsHide: true, env: helperEnvironment() },
	);
	let exited = false;
	child.on("error", () => (exited = true));
	child.on("exit", () => (exited = true));
	child.unref();
	const deadline = Date.now() + (options.timeout ?? 20_000);
	while (Date.now() < deadline) {
		await delay(250);
		const descriptor = await readRuntimeDescriptor(options.root);
		if (descriptor) return descriptor;
		// A concurrent start may own the profile lock; keep waiting for its descriptor.
		if (exited && !(await liveLockOwner(options.root)))
			throw new Error(
				"Laplace Runtime could not initialize. Check that the system keychain is available.",
			);
	}
	throw new Error("Laplace Runtime did not start. Check its runtime installation.");
}
/** Explicit stop: persists until a manual start or the next login. */
export async function stopRuntime(root: string, timeout = 15_000) {
	await mkdir(root, { recursive: true, mode: 0o700 });
	await writeFile(stoppedMarker(root), JSON.stringify({ at: new Date().toISOString() }), {
		mode: 0o600,
	});
	const descriptor = await readRuntimeDescriptor(root);
	if (!descriptor) return false;
	await controlRequest(descriptor, "shutdown", {}, 10_000).catch(() => {});
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			process.kill(descriptor.pid, 0);
		} catch {
			return true;
		}
		await delay(250);
	}
	// Process guardians terminate connector trees if the runtime itself is killed.
	process.kill(descriptor.pid, "SIGTERM");
	return true;
}

type Autostart = { launcher: string; hidden?: string; profile: RuntimeProfile };
const plistPath = (profile: RuntimeProfile) =>
	join(homedir(), "Library", "LaunchAgents", `${runtimeProfiles[profile].label}.plist`);
const unitName = (profile: RuntimeProfile) =>
	profile === "hosted" ? "laplace-runtime.service" : "laplace-runtime-development.service";
const unitPath = (profile: RuntimeProfile) =>
	join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
		"systemd",
		"user",
		unitName(profile),
	);
const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const runValue = (profile: RuntimeProfile) =>
	profile === "hosted" ? "LaplaceRuntime" : "LaplaceRuntimeDevelopment";
const xml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Login entry arguments: `--login` clears an explicit stop, matching "until next login". */
export const loginArguments = (profile: RuntimeProfile) => ["login", "--profile", profile];

export function launchAgent({ launcher, profile }: Autostart) {
	const args = [launcher, ...loginArguments(profile)];
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${runtimeProfiles[profile].label}</string>
	<key>ProgramArguments</key>
	<array>
${args.map((value) => `		<string>${xml(value)}</string>`).join("\n")}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;
}
export function systemdUnit({ launcher, profile }: Autostart) {
	const quote = (value: string) => `"${value.replace(/(["\\])/g, "\\$1")}"`;
	return `[Unit]
Description=Laplace Runtime (${profile})

[Service]
Type=oneshot
RemainAfterExit=no
ExecStart=${[launcher, ...loginArguments(profile)].map(quote).join(" ")}
KillMode=process

[Install]
WantedBy=default.target
`;
}
export function windowsRunCommand({ launcher, hidden, profile }: Autostart) {
	const quote = (value: string) => `"${value}"`;
	return [hidden ?? launcher, ...(hidden ? [launcher] : []), ...loginArguments(profile)]
		.map(quote)
		.join(" ");
}

export async function autostartEnabled(profile: RuntimeProfile) {
	try {
		if (process.platform === "darwin") {
			await readFile(plistPath(profile));
			return true;
		}
		if (process.platform === "win32") {
			await execute("reg.exe", ["query", runKey, "/v", runValue(profile)], { windowsHide: true });
			return true;
		}
		await readFile(unitPath(profile));
		const { stdout } = await execute("systemctl", ["--user", "is-enabled", unitName(profile)]);
		return stdout.trim() === "enabled";
	} catch {
		return false;
	}
}
/** Registers a per-user login start. It never respawns the runtime after it exits. */
export async function enableAutostart(options: Autostart) {
	if (options.profile !== "hosted") throw new Error("Only the production profile starts at login.");
	if (process.platform === "darwin") {
		const path = plistPath(options.profile);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, launchAgent(options), { mode: 0o644 });
		return;
	}
	if (process.platform === "win32") {
		await execute(
			"reg.exe",
			[
				"add",
				runKey,
				"/v",
				runValue(options.profile),
				"/t",
				"REG_SZ",
				"/d",
				windowsRunCommand(options),
				"/f",
			],
			{ windowsHide: true },
		);
		return;
	}
	const path = unitPath(options.profile);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, systemdUnit(options), { mode: 0o644 });
	await execute("systemctl", ["--user", "daemon-reload"]);
	await execute("systemctl", ["--user", "enable", unitName(options.profile)]);
}
export async function disableAutostart(profile: RuntimeProfile) {
	if (process.platform === "darwin") {
		await rm(plistPath(profile), { force: true });
		return;
	}
	if (process.platform === "win32") {
		await execute("reg.exe", ["delete", runKey, "/v", runValue(profile), "/f"], {
			windowsHide: true,
		}).catch(() => {});
		return;
	}
	await execute("systemctl", ["--user", "disable", unitName(profile)]).catch(() => {});
	await rm(unitPath(profile), { force: true });
	await execute("systemctl", ["--user", "daemon-reload"]).catch(() => {});
}
