import { expect, it } from "vitest";

import { connectClipboardWrite } from "../src/main/navigation";
import { webShellRequest } from "../src/main/web-shell";

it("limits shell messages to bounded presentation data from the primary trusted frame", () => {
	expect(webShellRequest.safeParse({ kind: "update-status" }).success).toBe(true);
	expect(webShellRequest.safeParse({ kind: "show-updates" }).success).toBe(true);
	expect(webShellRequest.safeParse({ kind: "show-updates", install: true }).success).toBe(false);
	expect(webShellRequest.safeParse({ kind: "shell.updateInstall" }).success).toBe(false);
	const rect = { x: 240, y: 0, width: 960, height: 820, blocked: false };
	expect(webShellRequest.safeParse({ kind: "layout", rect }).success).toBe(true);
	for (const invalid of [
		{ kind: "server.start", input: {} },
		{ kind: "web", url: "file:///tmp/private" },
		{ kind: "layout", rect: { ...rect, x: -1 } },
		{ kind: "layout", rect: { ...rect, width: Infinity } },
		{ kind: "layout", rect: { ...rect, height: 0 } },
		{ kind: "layout", rect: { ...rect, width: 100_001 } },
		{ kind: "layout", rect: { ...rect, blocked: "false" } },
	])
		expect(webShellRequest.safeParse(invalid).success).toBe(false);
	const origin = "https://connect.withlaplace.com";
	expect(connectClipboardWrite(true, true, `${origin}/team/home`, origin)).toBe(true);
	expect(connectClipboardWrite(false, true, origin, origin)).toBe(false);
	expect(connectClipboardWrite(true, false, origin, origin)).toBe(false);
	expect(connectClipboardWrite(true, true, "https://builder.withlaplace.com", origin)).toBe(false);
});
