import { registerBrowserNativeHost as registerExisting } from "@repo/browser-runtime/browser-native-host";
import { installBrowserNativeHost } from "@repo/browser-runtime/native-installation";
import { browserEnabled } from "@repo/local-mcp-core/browser-catalog";

export * from "@repo/browser-runtime/browser-native-host";

/** Accepted client releases use shared ownership from their first installation. */
export async function registerBrowserNativeHost(
	resources: string,
	options: Parameters<typeof registerExisting>[1] = {},
) {
	if (browserEnabled(options.platform)) {
		await installBrowserNativeHost(resources, { ...options, client: "desktop" });
	} else {
		// The runtime retains an already-shared registration even during rollback.
		await registerExisting(resources, options);
	}
}
