import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/** Profiles mirror Desktop's: production autostarts, development never does. */
export const runtimeProfiles = {
	hosted: { origin: "https://connect.withlaplace.com", label: "com.withlaplace.runtime" },
	local: { origin: "http://127.0.0.1:3004", label: "com.withlaplace.runtime.development" },
} as const;
export const runtimeProfile = z.enum(["hosted", "local"]);
export type RuntimeProfile = z.infer<typeof runtimeProfile>;

type Platform = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string };
const context = (value: Platform = {}) => ({
	platform: value.platform ?? process.platform,
	env: value.env ?? process.env,
	home: value.home ?? homedir(),
});

/** Electron's userData for productName "Laplace"; keychain identities depend on these paths. */
export function userDataRoot(options?: Platform) {
	const { platform, env, home } = context(options);
	if (platform === "darwin") return join(home, "Library", "Application Support", "Laplace");
	if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Laplace");
	return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Laplace");
}
export function profileRoot(profile: RuntimeProfile, options?: Platform) {
	const { env } = context(options);
	return env.LAPLACE_RUNTIME_ROOT ?? join(userDataRoot(options), "profiles", profile);
}
/** Versioned runtime installs live outside any application bundle. */
export function runtimeHome(options?: Platform) {
	const { platform, env, home } = context(options);
	if (env.LAPLACE_RUNTIME_HOME) return env.LAPLACE_RUNTIME_HOME;
	if (platform === "darwin") return join(userDataRoot(options), "runtime");
	if (platform === "win32")
		return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Laplace", "runtime");
	return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "laplace", "runtime");
}
