import { join } from "node:path";

import { serverConfig, type ServerConfig } from "@repo/local-mcp-core/config";

import {
	slackBrowserVersion,
	slackReadNames,
	slackSetupNames,
	slackWorkspace,
} from "../shared/slack-browser";

export const slackBrowserIdentity = `slack-mcp-server@${slackBrowserVersion}`;
export const legacySlackIdentity = "slack-mcp-server@1.1.0-laplace.1";
export function slackBrowserConfig(workspace: string, resources: string, nodePath: string) {
	return serverConfig.parse({
		id: "slack",
		name: "Slack",
		transport: "stdio",
		enabled: false,
		command: nodePath,
		args: [join(resources, "helper", "slack-browser.cjs"), slackWorkspace(workspace)],
		env: {},
		identity: slackBrowserIdentity,
		enabledTools: [...slackReadNames, ...slackSetupNames],
	});
}
/** Only a proven catalog attachment is upgraded. Custom configurations are never replaced. */
export function upgradeSlackConfig(
	config: ServerConfig,
	resources: string,
	nodePath: string,
): ServerConfig {
	if (config.identity === slackBrowserIdentity && config.enabledTools)
		return { ...config, enabledTools: [...new Set([...config.enabledTools, ...slackSetupNames])] };
	if (config.identity !== legacySlackIdentity || config.transport !== "stdio") return config;
	const index = config.args.indexOf("--workspace");
	if (index < 0) throw new Error("Legacy Slack catalog configuration has no workspace URL.");
	return {
		...slackBrowserConfig(config.args[index + 1]!, resources, nodePath),
		id: config.id,
		name: config.name,
		enabled: false,
		generation: config.generation,
		enabledTools: [
			...(config.enabledTools?.filter((name) => slackReadNames.includes(name)) ?? slackReadNames),
			...slackSetupNames,
		],
	};
}
