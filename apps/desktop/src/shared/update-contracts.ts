export type UpdatePhase =
	| "unmanaged"
	| "idle"
	| "checking"
	| "available"
	| "downloading"
	| "building"
	| "verifying"
	| "ready"
	| "installing"
	| "error";

/** Public state deliberately excludes paths, commands and Git authentication. */
export interface DesktopUpdateState {
	phase: UpdatePhase;
	installedVersion: string;
	availableVersion?: string;
	message?: string;
	checkedAt?: string;
}
