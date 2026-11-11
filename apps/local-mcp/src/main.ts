import { runCli } from "./cli";
import { cliIo } from "./io";
void runCli({ ...cliIo, argv: process.argv.slice(2) }).catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : "Laplace command failed"}\n`);
	process.exitCode = 1;
});
