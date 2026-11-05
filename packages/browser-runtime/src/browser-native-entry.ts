import { join } from "node:path";

import { runBrowserNativeHost } from "./browser-native-host";

void runBrowserNativeHost(
	process.argv[2] ?? "",
	process.stdin,
	process.stdout,
	process.env.LAPLACE_DESKTOP_TEST_ROOT
		? join(process.env.LAPLACE_DESKTOP_TEST_ROOT, "browser-requests")
		: undefined,
).then(
	() => {
		process.exitCode = 0;
	},
	() => {
		process.exitCode = 1;
	},
);
