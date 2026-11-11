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
import { swapRunningRuntime } from "./update";

/** The versioned runtime directory this launcher was installed in (versions/<v>). */
const installation = () => process.env.LAPLACE_CLI_RUNTIME_DIRECTORY ?? dirname(__dirname);
const option = (args: string[], name: string) => {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
};
export function launchOptions(profile: RuntimeProfile, directory = installation()) {
	return {
		root: profileRoot(profile),
		node: join(directory, "runtimes", process.platform === "win32" ? "node.exe" : "node"),
		service: join(directory, "helper", "service.cjs"),
		resources: directory,
		origin: runtimeProfiles[profile].origin,
		nativeHost: true,
	};
}
async function status(profile: RuntimeProfile, root = profileRoot(profile)) {
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
	const options = {
		...launchOptions(profile),
		root: resolve(option(args, "--root") ?? profileRoot(profile)),
		nativeHost: !args.includes("--no-native-host"),
	};
	switch (command) {
		case "autostart":
			// Login clears an explicit stop; the runtime then serves until stopped again.
			return startRuntime({ ...options, explicit: true }).then(() => ({ started: true }));
		case "start":
			await startRuntime({ ...options, explicit: true });
			return status(profile, options.root);
		case "stop":
			await stopRuntime(options.root);
			return status(profile, options.root);
		case "status":
			return status(profile, options.root);
		case "enable": {
			const { launcher, hidden } = stableLaunchers();
			await enableAutostart({
				launcher,
				hidden: process.platform === "win32" ? hidden : undefined,
				profile,
			});
			return status(profile, options.root);
		}
		case "disable":
			await disableAutostart(profile);
			return status(profile, options.root);
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
			// A running runtime drains and moves to the new version; otherwise start it.
			const swap = await swapRunningRuntime({
				root: options.root,
				origin: options.origin,
				nativeHost: true,
			});
			if (swap.swapped === false && swap.reason === "not-running")
				await startRuntime({ ...launchOptions(profile, installed.directory), explicit: true });
			return {
				installed: installed.version,
				launcher: installed.launcher,
				update: swap,
				...(await status(profile, options.root)),
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
		case "connectors": {
			// Same operations AI clients reach over MCP, for agents that only have a shell.
			const [, action, id, value, extra] = args;
			const descriptor = await readRuntimeDescriptor(options.root);
			if (!descriptor)
				throw new Error("Laplace Runtime is not running. Run laplace-runtime start.");
			if (action === "versions" && id) return controlRequest(descriptor, "npm.versions", { id });
			if (action === "set-version" && id && value)
				return controlRequest(descriptor, "npm.setVersion", { id, version: value }, 300_000);
			if (action === "add-npm" && id && value)
				return controlRequest(
					descriptor,
					"npm.add",
					{
						id,
						name: option(args, "--name") ?? id,
						package: value,
						version: extra && !extra.startsWith("--") ? extra : "latest",
						bin: option(args, "--bin"),
					},
					300_000,
				);
			throw new Error(
				"Use laplace-runtime connectors versions <id> | set-version <id> <version|tag> | add-npm <id> <package> [version] [--name <name>] [--bin <command>]",
			);
		}
		default:
			throw new Error(
				"Use laplace-runtime start|stop|status|enable|disable|install|connectors [--profile hosted|local]",
			);
	}
}
