import { describe, expect, it } from "vitest";

import {
	localConnectorDefinitions,
	localConnectorMetadata,
	localConnectorSetupPrompt,
	localConnectorSetupUrl,
} from "./local-mcp-setup";
describe("public local connector setup", () => {
	it("has one stable public URL per connector, including the demo", () => {
		const urls = localConnectorDefinitions.map((entry) => localConnectorSetupUrl(entry.id));
		expect(new Set(urls).size).toBe(7);
		for (const url of urls) expect(new URL(url).origin).toBe("https://connect.laplaceop.com");
	});
	it("labels activated tethered runtimes without relabeling old releases", () => {
		expect(
			localConnectorDefinitions
				.slice(0, 6)
				.map((entry) => localConnectorMetadata(entry.id, true).name),
		).toEqual([
			"Canvas [Background Browser]",
			"LinkedIn [Background Browser]",
			"Yale SOM EMS [Background Browser]",
			"Yale SOM CMS [Background Browser]",
			"Outlook [Tethered]",
			"Slack [Tethered]",
		]);
		expect(localConnectorMetadata("linkedin-mcp-server").name).toBe(
			"LinkedIn [Background Browser]",
		);
		expect(localConnectorMetadata("ycombinator-demo", true).name).toBe("Y Combinator · Demo Only");
	});
	it("uses only allowlisted context and encodes it as data", () => {
		const url = new URL(
			localConnectorSetupUrl("msoutlook-mcp", {
				organization: "a & b/#?",
				environment: "Development",
				token: "secret",
			} as never),
		);
		expect(url.searchParams.get("organization")).toBe("a & b/#?");
		expect(url.href).not.toContain("secret");
		expect(() => localConnectorSetupUrl("../../login")).toThrow();
		expect(() => localConnectorSetupUrl("msoutlook-mcp", { version: "a\nb" })).toThrow();
	});
	it("does not copy settings or instructions from catalog data", () => {
		const prompt = localConnectorSetupPrompt({
			id: "slack-mcp-server",
			name: "Slack [Tethered]",
			authentication: ["secret"],
		} as never);
		expect(prompt).toBe(
			"Please set up Slack [Tethered] with Laplace using these instructions: https://connect.laplaceop.com/local-mcp/setup/slack-mcp-server",
		);
	});
});
