/** Allowlisted environment for runtime hosts; connector output may echo anything it receives. */
export function helperEnvironment() {
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"PATH",
		"Path",
		"HOME",
		"USERPROFILE",
		"APPDATA",
		"LOCALAPPDATA",
		"SystemRoot",
		"WINDIR",
		"TEMP",
		"TMP",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"DBUS_SESSION_BUS_ADDRESS",
		"XDG_RUNTIME_DIR",
		"LAPLACE_RUNTIME_HOME",
		"LAPLACE_BROWSER_CONNECTION_ENABLED",
		"LAPLACE_AUTOMATIC_UPDATES_V1",
		"LAPLACE_NPM_CONNECTORS_V1",
		"LAPLACE_SESSION_RECOVERY_V1",
		"LAPLACE_TETHERED_BROWSER_V1",
		"ENABLE_CREDENTIAL_BROKERING",
	])
		if (process.env[key]) env[key] = process.env[key];
	return env;
}
