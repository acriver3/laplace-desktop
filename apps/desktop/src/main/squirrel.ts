import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

import { app } from "electron";

/** Squirrel invokes the application during install/update/removal. These
 * invocations must never open the manager or acquire provider profiles. */
export function handleSquirrelEvents(): boolean {
	if (process.platform !== "win32") return false;
	app.setAppUserModelId("com.squirrel.Laplace.Laplace");
	const event = process.argv[1];
	if (event === "--squirrel-obsolete") {
		app.quit();
		return true;
	}
	if (!["--squirrel-install", "--squirrel-updated", "--squirrel-uninstall"].includes(event ?? ""))
		return false;
	const action = event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut";
	const updater = resolve(dirname(process.execPath), "..", "Update.exe");
	const child = spawn(updater, [action, basename(process.execPath)], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	const timeout = setTimeout(() => app.quit(), 5000);
	const finish = () => {
		clearTimeout(timeout);
		app.quit();
	};
	child.once("error", finish);
	child.once("close", finish);
	return true;
}
