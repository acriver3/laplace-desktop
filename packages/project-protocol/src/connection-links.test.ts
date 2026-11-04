import { expect, it } from "vitest";

import { connectionSelection, connectionUrl } from "./connection-links";
import { providerInitials, providerLogoPath } from "./connector-artwork";

it("creates selection-only links and validates every deep-link field", () => {
	const id = "10000000-0000-4000-8000-000000000001";
	const url = connectionUrl("https://connect.example", "pop-thrills", {
		provider: "github",
		installationId: id,
		connectionId: id,
	});
	expect(new URL(url).pathname).toBe("/pop-thrills/connections");
	expect(connectionSelection(new URL(url).searchParams)).toMatchObject({
		provider: "github",
		installationId: id,
		connectionId: id,
	});
	expect(
		connectionSelection(
			new URLSearchParams(
				"provider=github&provider=slack&installation=wrong&localConnection=" + id,
			),
		),
	).toMatchObject({ provider: undefined, installationId: undefined, connectionId: undefined });
	expect(
		new URL(
			connectionUrl("https://connect.example", "account", {
				setup: "javascript:alert(1)",
				installationId: "../foreign",
			}),
		).search,
	).toBe("");
});

it("uses only vendored logo paths and the shared YC/initials fallbacks", () => {
	expect(providerLogoPath("ycombinator", {})).toBe("/images/provider-logos/ycombinator-demo.svg");
	expect(providerLogoPath("github", { github: "/images/provider-logos/github.svg" })).toContain(
		"github.svg",
	);
	expect(providerLogoPath("bad", { bad: "https://foreign.example/pixel" })).toBeUndefined();
	expect(providerLogoPath("missing", {})).toBeUndefined();
	expect(providerInitials("Missing")).toBe("MI");
});
