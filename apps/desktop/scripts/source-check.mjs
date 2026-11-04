import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export function sourceCheckEnvironment(source = process.env) {
	return {
		...Object.fromEntries(
			Object.entries(source).filter(([key]) =>
				/^(PATH|Path|HOME|USER|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|WINDIR|COMSPEC|SHELL|TMPDIR|TMP|TEMP|LANG|LC_ALL|PNPM_HOME|npm_execpath)$/.test(
					key,
				),
			),
		),
		CI: "true",
		ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
	};
}

export function checkDesktopSource({ run = execute, env = process.env } = {}) {
	const childEnv = sourceCheckEnvironment(env);
	for (const script of ["type-check", "test", "build"]) run(script, childEnv);
}

function execute(script, env) {
	const cli = env.npm_execpath;
	const useNode = cli && /pnpm/i.test(cli);
	const result = spawnSync(
		useNode ? process.execPath : "pnpm",
		useNode ? [cli, "run", script] : ["run", script],
		{
			cwd: root,
			env,
			stdio: "inherit",
			shell: !useNode && process.platform === "win32",
			windowsHide: true,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Desktop source check failed: ${script}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	checkDesktopSource();
