import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { readRuntimeDescriptor, controlRequest } from "./control";
import { installRuntime, stableLaunchers } from "./install";
import {
	autostartEnabled,
	disableAutostart,
	enableAutostart,
	explicitlyStopped,
	startRuntime,
	stopRuntime,
} from "./lifecycle";
import { profileRoot, runtimeProfile, runtimeProfiles, type RuntimeProfile } from "./paths";

/** The versioned runtime directory this launcher was installed in (versions/<v>). */
const installation = () => dirname(__dirname);
const option = (args: string[], name: string) => {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
};
export function launchOptions(profile: RuntimeProfile, directory = installation()) {
	return {
		root: profileRoot(profile),
		node: process.execPath,
		service: join(directory, "helper", "service.cjs"),
		resources: directory,
		origin: runtimeProfiles[profile].origin,
		nativeHost: true,
	};
}
async function status(profile: RuntimeProfile) {
	const root = profileRoot(profile);
	const descriptor = await readRuntimeDescriptor(root);
	const snapshot = descriptor
		? await controlRequest<{ mode: string; servers: unknown[]; clients: unknown[] }>(
				descriptor,
				"status",
			).catch(() => undefined)
		: undefined;
	return {
		profile,
		running: !!descriptor,
		pid: descriptor?.pid,
		explicitlyStopped: await explicitlyStopped(root),
		startAtLogin: await autostartEnabled(profile),
		mode: snapshot?.mode,
		connectors: snapshot?.servers.length,
		clients: snapshot?.clients.length,
		version:
			(await readFile(join(installation(), "VERSION"), "utf8").catch(() => "")).trim() || undefined,
	};
}

/** `laplace-runtime <command>`: lifecycle commands handled without a running runtime. */
export async function runLauncher(args = process.argv.slice(2)): Promise<unknown> {
	const [command] = args;
	const profile = runtimeProfile.parse(option(args, "--profile") ?? "hosted");
	const options = launchOptions(profile);
	switch (command) {
		case "autostart":
			// Login clears an explicit stop; the runtime then serves until stopped again.
			return startRuntime({ ...options, explicit: true }).then(() => ({ started: true }));
		case "start":
			await startRuntime({ ...options, explicit: true });
			return status(profile);
		case "stop":
			await stopRuntime(options.root);
			return status(profile);
		case "status":
			return status(profile);
		case "enable": {
			const { launcher, hidden } = stableLaunchers();
			await enableAutostart({
				launcher,
				hidden: process.platform === "win32" ? hidden : undefined,
				profile,
			});
			return status(profile);
		}
		case "disable":
			await disableAutostart(profile);
			return status(profile);
		case "install": {
			// Headless archives install themselves into the stable per-user location.
			const version = (await readFile(join(installation(), "VERSION"), "utf8")).trim();
			const installed = await installRuntime(installation(), version);
			if (!args.includes("--no-autostart") && profile === "hosted") {
				const { launcher, hidden } = stableLaunchers();
				await enableAutostart({
					launcher,
					hidden: process.platform === "win32" ? hidden : undefined,
					profile,
				});
			}
			await stopRuntime(options.root).catch(() => {});
			await startRuntime({ ...launchOptions(profile, installed.directory), explicit: true });
			return {
				installed: installed.version,
				launcher: installed.launcher,
				...(await status(profile)),
			};
		}
		case "bridge": {
			process.argv = [
				process.argv[0]!,
				process.argv[1]!,
				"--root",
				resolve(option(args, "--root") ?? options.root),
				"--client-id",
				option(args, "--client-id") ?? "",
			];
			const { runBridge } = await import("./bridge");
			await runBridge();
			return undefined;
		}
		default:
			throw new Error(
				"Use laplace-runtime start|stop|status|enable|disable|install [--profile hosted|local]",
			);
	}
}
