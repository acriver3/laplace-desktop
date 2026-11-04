import { main } from "./cli";

void main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Source update failed.");
	process.exitCode = 1;
});
