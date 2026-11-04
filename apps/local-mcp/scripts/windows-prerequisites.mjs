import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

const repairMessage =
	"Windows runtime preparation requires MSVC build tools. Install Visual Studio Build Tools " +
	"with the Desktop development with C++ workload (MSVC x64/x86 tools and Windows SDK), " +
	"or run this command from an x64 Native Tools Command Prompt. Packaged Laplace users do not need a compiler.";

/** Resolve compiler paths at build time, including when an updater starts from Explorer. */
export function windowsCompilerEnvironment({
	platform = process.platform,
	env = process.env,
	run = spawnSync,
	exists = existsSync,
} = {}) {
	if (platform !== "win32" || (env.INCLUDE && env.LIB)) return { ...env };
	const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
	const programFiles =
		env["ProgramFiles(x86)"] || win32.join(win32.parse(systemRoot).root, "Program Files (x86)");
	const vswhere = win32.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
	if (!exists(vswhere)) throw new Error(repairMessage);
	// `set` must not serialize application secrets, even into captured subprocess output.
	const safe = Object.fromEntries(
		Object.entries(env).filter(([key]) =>
			/^(Path|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|SystemDrive|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(
				key,
			),
		),
	);
	safe.SystemRoot = systemRoot;
	safe["ProgramFiles(x86)"] = programFiles;
	const options = { env: safe, encoding: "utf8", windowsHide: true, timeout: 60_000 };
	const located = run(
		vswhere,
		[
			"-latest",
			"-products",
			"*",
			"-requires",
			"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
			"-property",
			"installationPath",
		],
		options,
	);
	const installation = located.stdout?.trim();
	if (
		located.error ||
		located.status !== 0 ||
		!installation ||
		!win32.isAbsolute(installation) ||
		/["%!^\r\n]/.test(installation) ||
		installation.includes("\0")
	)
		throw new Error(repairMessage);
	const batch = win32.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat");
	if (!exists(batch)) throw new Error(repairMessage);
	const initialized = run(
		win32.join(systemRoot, "System32", "cmd.exe"),
		["/d", "/s", "/c", `""${batch}" >nul && set"`],
		{
			...options,
			windowsVerbatimArguments: true,
		},
	);
	if (initialized.error || initialized.status !== 0) throw new Error(repairMessage);
	const compiler = {};
	for (const line of (initialized.stdout ?? "").split(/\r?\n/)) {
		const match = /^(PATH|INCLUDE|LIB|LIBPATH)=(.*)$/i.exec(line);
		if (match) compiler[match[1].toUpperCase()] = match[2];
	}
	if (!compiler.PATH || !compiler.INCLUDE || !compiler.LIB) throw new Error(repairMessage);
	// Windows environment keys are case insensitive; avoid two competing PATH entries.
	return {
		...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH")),
		...compiler,
	};
}

// Run before downloading assets so a missing native compiler fails immediately.
export function assertWindowsBuildTools({
	platform = process.platform,
	run = spawnSync,
	env,
} = {}) {
	if (platform !== "win32") return;
	const compilerEnvironment = env ?? windowsCompilerEnvironment({ platform, run });
	const directory = mkdtempSync(join(tmpdir(), "laplace-msvc-check-"));
	let result;
	try {
		const source = join(directory, "probe.c");
		writeFileSync(
			source,
			"#include <windows.h>\nint main(void) { return GetCurrentProcessId() == 0; }\n",
		);
		// A compiler on PATH alone does not prove the Windows SDK and linker
		// environment are ready. Compile and link without executing the probe.
		result = run("cl.exe", ["/nologo", "/MT", source, `/Fe:${join(directory, "probe.exe")}`], {
			cwd: directory,
			stdio: "ignore",
			windowsHide: true,
			env: compilerEnvironment,
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	if (result.error || result.status !== 0) throw new Error(repairMessage);
	return compilerEnvironment;
}
