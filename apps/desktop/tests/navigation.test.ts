import { describe, expect, it } from "vitest";

import {
	agentHandoffUrl,
	connectClipboardWrite,
	desktopLocalNavigation,
	externalUrl,
	permittedWebOrigin,
	trustedRenderer,
} from "../src/main/navigation";

describe("desktop navigation boundary", () => {
	it("only reveals the local manager for an exact action from the primary Connect page", () => {
		const origin = "https://connect.withlaplace.com";
		const source = `${origin}/personal-fixture/home`;
		const destination = `${origin}/desktop/local`;
		expect(desktopLocalNavigation(true, source, destination, origin)).toBe(true);
		expect(desktopLocalNavigation(false, source, destination, origin)).toBe(false);
		for (const from of [
			"https://builder.withlaplace.com/chat/new",
			"https://provider.fixture.invalid/",
			"https://connect.withlaplace.com.evil.invalid/",
			"http://127.0.0.1:3004/home",
			"https://user:password@connect.withlaplace.com/home",
			"about:blank",
		])
			expect(desktopLocalNavigation(true, from, destination, origin)).toBe(false);
		for (const target of [
			`${destination}?action=server.start`,
			`${destination}?`,
			`${destination}#manager`,
			`${destination}/`,
			`${origin}/desktop/%6cocal`,
			"https://user:password@connect.withlaplace.com/desktop/local",
			"https://builder.withlaplace.com/desktop/local",
			"https://connect.withlaplace.com.evil.invalid/desktop/local",
			"http://127.0.0.1:3004/desktop/local",
			"laplace-desktop://app/desktop/local",
		])
			expect(desktopLocalNavigation(true, source, target, origin)).toBe(false);
		const local = "http://127.0.0.1:3004";
		expect(desktopLocalNavigation(true, `${local}/home`, `${local}/desktop/local`, local)).toBe(
			true,
		);
		expect(
			desktopLocalNavigation(true, "http://localhost:3004/home", `${local}/desktop/local`, local),
		).toBe(false);
	});
	it.each([
		"https://connect.withlaplace.com/home?tab=all",
		"https://builder.withlaplace.com/chat/new",
		"https://build.withlaplace.com/",
		"https://builder-preview.withlaplace.com/",
	])("retains configured hosted origin %s", (url) =>
		expect(permittedWebOrigin("hosted", url)).toBe(true),
	);
	it.each([
		"https://connect.withlaplace.com.evil.invalid/",
		"https://evil.invalid/connect.withlaplace.com",
		"https://user:password@connect.withlaplace.com/",
		"https://generated.build.withlaplace.com/",
		"http://connect.withlaplace.com/",
		"http://127.0.0.1:3004/",
		"javascript:alert(1)",
		"file:///private/secret",
		"not a URL",
	])("rejects untrusted hosted navigation %s", (url) =>
		expect(permittedWebOrigin("hosted", url)).toBe(false),
	);
	it("keeps local and hosted origins separate", () => {
		for (const url of [
			"http://127.0.0.1:3004",
			"http://localhost:3004",
			"http://127.0.0.1:5174",
			"http://localhost:5174",
		])
			expect(permittedWebOrigin("local", url)).toBe(true);
		for (const url of [
			"https://connect.withlaplace.com",
			"http://127.0.0.1:9999",
			"http://localhost.evil.invalid:3004",
		])
			expect(permittedWebOrigin("local", url)).toBe(false);
	});
	it("opens only credential-free HTTP(S) URLs externally", () => {
		expect(externalUrl("https://provider.example/consent?state=opaque")).toBe(
			"https://provider.example/consent?state=opaque",
		);
		expect(externalUrl("http://127.0.0.1:3004/login")).toBe("http://127.0.0.1:3004/login");
		for (const url of [
			"javascript:alert(1)",
			"file:///tmp/file",
			"data:text/html,test",
			"https://user:secret@provider.example",
			"mailto:test@example.com",
			"invalid",
		])
			expect(externalUrl(url)).toBeNull();
	});
	it("grants trusted shell status only to the bundled origin or exact development origin", () => {
		expect(trustedRenderer("laplace-desktop://app/index.html")).toBe(true);
		expect(trustedRenderer("laplace-desktop://remote/index.html")).toBe(false);
		expect(trustedRenderer("https://connect.withlaplace.com")).toBe(false);
		expect(trustedRenderer("http://127.0.0.1:5173/index.html", "http://127.0.0.1:5173")).toBe(true);
		expect(trustedRenderer("http://127.0.0.1:5174", "http://127.0.0.1:5173")).toBe(false);
		expect(trustedRenderer("http://127.0.0.1.evil.invalid:5173", "http://127.0.0.1:5173")).toBe(
			false,
		);
	});
});

const connect = "https://connect.withlaplace.com";
describe("Connect agent handoff", () => {
	it.each([
		"codex://threads/new?prompt=Hello%20world",
		"claude://claude.ai/new?q=Hello",
		"claude://code/new?q=Hello",
		"cursor://anysphere.cursor-deeplink/mcp/install?name=laplace&config=e30%3D",
	])("opens supported agent route %s only from Connect", (url) => {
		expect(agentHandoffUrl(url, `${connect}/home`, connect)).toBe(url);
		for (const source of ["https://builder.withlaplace.com", "https://evil.invalid", "about:blank"])
			expect(agentHandoffUrl(url, source, connect)).toBeNull();
		expect(externalUrl(url)).toBeNull();
	});
	it.each([
		"codex://settings",
		"codex://threads/new/",
		"codex://user@threads/new",
		"claude://code/execute",
		"cursor://anysphere.cursor-deeplink/run",
		"file:///tmp/test",
		"javascript:alert(1)",
		"other://threads/new",
	])("rejects unsupported native route %s", (url) => {
		expect(agentHandoffUrl(url, connect, connect)).toBeNull();
	});
	it("allows only main Connect clipboard writes", () => {
		const allowed = (primary = true, main = true, url = `${connect}/home`) =>
			connectClipboardWrite(primary, main, url, connect);
		expect(allowed()).toBe(true);
		expect(allowed(false)).toBe(false);
		expect(allowed(true, false)).toBe(false);
		for (const url of [
			"https://builder.withlaplace.com",
			"https://connect.withlaplace.com.evil.invalid",
			"about:blank",
			"",
		])
			expect(allowed(true, true, url)).toBe(false);
	});
});
