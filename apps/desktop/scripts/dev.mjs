import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
execFileSync(process.execPath, ["scripts/runtimes.mjs"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), ["."], { stdio: "inherit", env });
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
