import { expect, it } from "vitest";

import { localMcpArtifacts, localMcpReleaseArtifacts } from "./local-mcp-artifacts";

it("advertises the qualified Mac release and preserves other platforms and immutable downloads", () => {
	expect(new Set(localMcpArtifacts.map((a) => a.platform)).size).toBe(4);
	for (const artifact of localMcpArtifacts) {
		expect(artifact.version).toBe(artifact.platform === "darwin-arm64" ? "0.1.3" : "0.1.0");
	}
	expect(new Set(localMcpReleaseArtifacts("0.1.3").map((a) => a.platform))).toEqual(
		new Set(["darwin-arm64"]),
	);
	for (const version of ["0.1.0", "0.1.1", "0.1.2"]) {
		expect(new Set(localMcpReleaseArtifacts(version).map((a) => a.platform)).size).toBe(4);
	}
});
