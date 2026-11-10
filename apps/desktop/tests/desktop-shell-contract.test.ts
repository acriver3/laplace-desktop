import { describe, expect, it } from "vitest";

import { restorableWebUrl, webSessionEnded } from "../src/main/navigation";
import { resolveLocalSection, shellRequest } from "../src/shared/shell-contracts";

const origin = "https://connect.withlaplace.com";

describe("web-first Desktop navigation", () => {
	it("reopens the last Connect page and otherwise starts at Connect's home", () => {
		for (const url of [
			`${origin}/workspace-a/connections?setup=github`,
			`${origin}/workspace-a/settings/members`,
			`${origin}/workspace-a/home#recent`,
		])
			expect(restorableWebUrl(url, origin)).toBe(url);
		for (const url of [
			undefined,
			"",
			"not a URL",
			`${origin}/login`,
			`${origin}/desktop/local`,
			`${origin}/desktop/sign-in?state=opaque`,
			"https://user:secret@connect.withlaplace.com/workspace-a/home",
			"https://connect.withlaplace.com.evil.invalid/workspace-a/home",
			"https://builder.withlaplace.com/chat/new",
			"http://127.0.0.1:3004/workspace-a/home",
		])
			expect(restorableWebUrl(url, origin)).toBe(`${origin}/`);
	});

	it("treats only Connect's own login page as an ended session", () => {
		expect(webSessionEnded(`${origin}/login`, origin)).toBe(true);
		expect(webSessionEnded(`${origin}/login?redirectTo=%2Fhome`, origin)).toBe(true);
		for (const url of [
			`${origin}/workspace-a/home`,
			`${origin}/login/extra`,
			"https://accounts.google.com/login",
			"https://connect.withlaplace.com.evil.invalid/login",
			"invalid",
		])
			expect(webSessionEnded(url, origin)).toBe(false);
	});
});

describe("trusted shell request contracts", () => {
	it("switches only between named local sections and Connect", () => {
		for (const section of [
			"servers",
			"clients",
			"info",
			"tools",
			"settings",
			"updates",
			"device",
			"credentials",
		])
			expect(shellRequest.safeParse({ method: "shell.local", input: { section } }).success).toBe(
				true,
			);
		expect(resolveLocalSection("device")).toBe("settings");
		for (const section of ["info", "tools", "settings", "updates"] as const)
			expect(resolveLocalSection(section)).toBe(section);
		expect(shellRequest.safeParse({ method: "shell.web" }).success).toBe(true);
		for (const request of [
			{ method: "shell.local", input: { section: "billing" } },
			{ method: "shell.local", input: { section: "servers", url: "https://other.invalid" } },
			{ method: "shell.web", input: { url: "https://other.invalid" } },
		])
			expect(shellRequest.safeParse(request).success).toBe(false);
	});

	it("no longer accepts renderer-driven workspace reads, routing, or view positioning", () => {
		for (const request of [
			{ method: "shell.navigate", input: { route: { section: "apps" } } },
			{ method: "shell.viewport", input: { x: 0, y: 0, width: 1, height: 1, visible: true } },
			{ method: "shell.accountData", input: { operation: "connections" } },
			{ method: "shell.selectWorkspace", input: { workspaceId: "workspace-b" } },
			{ method: "shell.openFeature", input: { feature: "builder" } },
			{ method: "shell.tab", input: { tab: "laplace" } },
		])
			expect(shellRequest.safeParse(request).success).toBe(false);
	});
});
