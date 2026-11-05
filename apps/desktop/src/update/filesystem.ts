import * as nodeFs from "node:fs/promises";
import { createRequire } from "node:module";

// Electron virtualizes app.asar as a directory. Updates must copy, hash and
// remove the physical archive, matching the standalone Node installer.
const filesystem: typeof nodeFs = process.versions.electron
	? createRequire(process.execPath)("original-fs").promises
	: nodeFs;

export const {
	access,
	copyFile,
	writeFile,
	cp,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	readlink,
	realpath,
	rename,
	rm,
	statfs,
} = filesystem;
