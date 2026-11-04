import { describe, expect, it } from "vitest";

import { matchRuntimeDomain, runtimeDomains } from "./runtime-domains";

describe("published app runtime domains", () => {
	const env = {
		APP_RUNTIME_DOMAIN: "apps.example.net",
		APP_RUNTIME_LEGACY_DOMAINS: "legacy.example.net",
	};

	it("keeps canonical and explicit historical domains available without widening trust", () => {
		expect(runtimeDomains(env)).toEqual(["apps.example.net", "legacy.example.net"]);
		expect(matchRuntimeDomain("ticket.apps.example.net", env)).toBe("apps.example.net");
		expect(matchRuntimeDomain("ticket.legacy.example.net", env)).toBe("legacy.example.net");
		for (const hostname of [
			"apps.example.net",
			"nested.ticket.apps.example.net",
			"ticket.example.net",
			"ticket.apps.example.net.attacker.com",
		])
			expect(matchRuntimeDomain(hostname, env)).toBeUndefined();
	});

	it("rejects aliases without a canonical domain or an invalid domain", () => {
		expect(() => runtimeDomains({ APP_RUNTIME_LEGACY_DOMAINS: "legacy.example.net" })).toThrow(
			"canonical",
		);
		expect(() => runtimeDomains({ APP_RUNTIME_DOMAIN: "https://apps.example.net" })).toThrow(
			"Invalid",
		);
	});
});
