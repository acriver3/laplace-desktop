export const LOCAL_MCP_RELEASE = "0.1.0";
// Keep previous immutable downloads usable when the advertised release advances.
export const LOCAL_MCP_DOWNLOAD_RELEASES = ["0.1.0", "0.1.1", "0.1.2"];
export const LOCAL_MCP_PLATFORMS = [
	"win32-x64",
	"darwin-x64",
	"darwin-arm64",
	"linux-x64",
] as const;
export function localMcpReleaseArtifacts(version: string) {
	return LOCAL_MCP_PLATFORMS.flatMap((platform) => [
		{
			name: `laplace-local-${version}-${platform}.manifest.json`,
			version,
			platform,
			kind: "manifest" as const,
		},
		{
			name: `laplace-local-${version}-${platform}.${platform === "win32-x64" ? "zip" : "tar.gz"}`,
			version,
			platform,
			kind: "cli" as const,
		},
		...(platform === "linux-x64"
			? []
			: [
					{
						name: `laplace-local-${version}-${platform}.mcpb`,
						version,
						platform,
						kind: "desktop" as const,
					},
				]),
	]);
}
export const localMcpArtifacts = localMcpReleaseArtifacts(LOCAL_MCP_RELEASE);
