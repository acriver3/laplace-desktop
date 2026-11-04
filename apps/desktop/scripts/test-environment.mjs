// Keep development credentials out of synthetic Electron checks.
export function testEnvironment(extra = {}) {
	const env = {};
	for (const name of [
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
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"XAUTHORITY",
		"DBUS_SESSION_BUS_ADDRESS",
		"XDG_RUNTIME_DIR",
	])
		if (process.env[name]) env[name] = process.env[name];
	return { ...env, ...extra };
}
