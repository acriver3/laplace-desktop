import { expect, it, vi } from "vitest";

import {
	assertWindowsBuildTools,
	windowsCompilerEnvironment,
} from "../scripts/windows-prerequisites.mjs";

it("leaves non-Windows runtime preparation independent of MSVC", () => {
	const run = vi.fn();
	assertWindowsBuildTools({ platform: "linux", run });
	expect(run).not.toHaveBeenCalled();
});

it("allows an initialized Windows compiler environment", () => {
	const run = vi.fn(() => ({ status: 0 }));
	expect(() => assertWindowsBuildTools({ platform: "win32", run, env: {} })).not.toThrow();
});

it.each([
	{ error: Object.assign(new Error("spawn cl.exe ENOENT"), { code: "ENOENT" }), status: null },
	{ status: 1 },
	{ status: 2 },
])(
	"explains how to repair an unavailable Windows compiler before downloading runtimes",
	(result) => {
		const run = vi.fn(() => result);
		expect(() => assertWindowsBuildTools({ platform: "win32", run, env: {} })).toThrow(
			/Desktop development with C\+\+.*Windows SDK.*x64 Native Tools Command Prompt/,
		);
	},
);

it("restores compiler paths for a sanitized updater environment without passing credentials to discovery", () => {
	const run = vi
		.fn()
		.mockReturnValueOnce({
			status: 0,
			stdout: "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\r\n",
		})
		.mockReturnValueOnce({
			status: 0,
			stdout:
				"Path=C:\\compiler;C:\\Windows\\System32\r\nINCLUDE=C:\\sdk\\include\r\nLIB=C:\\sdk\\lib\r\nLIBPATH=C:\\sdk\\metadata\r\nUNRELATED=value\r\n",
		});
	const env = { SystemRoot: "C:\\Windows", Path: "C:\\tools", GH_TOKEN: "synthetic-secret" };
	const result = windowsCompilerEnvironment({ platform: "win32", env, run, exists: () => true });
	expect(run.mock.calls[0][0]).toBe(
		"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
	);
	for (const [, , options] of run.mock.calls) {
		expect(options.env).not.toHaveProperty("GH_TOKEN");
		expect(options.windowsHide).toBe(true);
		expect(options.timeout).toBe(60_000);
	}
	expect(result).toMatchObject({
		PATH: "C:\\compiler;C:\\Windows\\System32",
		INCLUDE: "C:\\sdk\\include",
		LIB: "C:\\sdk\\lib",
	});
	expect(result).not.toHaveProperty("Path");
	expect(result).not.toHaveProperty("UNRELATED");
	expect(env).toEqual({
		SystemRoot: "C:\\Windows",
		Path: "C:\\tools",
		GH_TOKEN: "synthetic-secret",
	});
});

it("uses an existing developer environment and fails safely when discovery is unavailable", () => {
	const run = vi.fn();
	const env = { PATH: "compiler", INCLUDE: "include", LIB: "lib" };
	expect(windowsCompilerEnvironment({ platform: "win32", env, run })).toEqual(env);
	expect(run).not.toHaveBeenCalled();
	expect(() =>
		windowsCompilerEnvironment({ platform: "win32", env: {}, run, exists: () => false }),
	).toThrow("Visual Studio Build Tools");
	for (const installation of ["relative/path", "C:\\unsafe%COMMAND%", 'C:\\unsafe" & bad']) {
		const discovered = vi.fn(() => ({ status: 0, stdout: installation }));
		expect(() =>
			windowsCompilerEnvironment({
				platform: "win32",
				env: {},
				run: discovered,
				exists: () => true,
			}),
		).toThrow("Visual Studio Build Tools");
		expect(discovered).toHaveBeenCalledTimes(1);
	}
});

it("rejects incomplete compiler discovery without exposing subprocess output", () => {
	const run = vi
		.fn()
		.mockReturnValueOnce({ status: 0, stdout: "C:\\Visual Studio" })
		.mockReturnValueOnce({ status: 0, stdout: "PATH=C:\\compiler\r\nGH_TOKEN=synthetic-secret" });
	expect(() =>
		windowsCompilerEnvironment({ platform: "win32", env: {}, run, exists: () => true }),
	).toThrow("Windows SDK");
});
