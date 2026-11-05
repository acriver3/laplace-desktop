import { join } from "node:path";

import { serverConfig } from "@repo/local-mcp-core/config";

import { ycBrowserIdentity, ycToolNames, ycSetupNames } from "./shared/yc-browser";

export function ycBrowserConfig(resources: string, nodePath: string) {
	return serverConfig.parse({
		id: "ycombinator-demo",
		name: "Y Combinator",
		transport: "stdio",
		enabled: false,
		command: nodePath,
		args: [join(resources, "helper", "yc-browser.cjs")],
		env: {},
		identity: ycBrowserIdentity,
		enabledTools: [...ycToolNames, ...ycSetupNames],
	});
}
