const path = require("node:path");
const macIdentity = process.env.LAPLACE_MAC_SIGN_IDENTITY || "-";
const localSigning = macIdentity === "-" || process.env.LAPLACE_MAC_SIGN_KIND === "local";

module.exports = {
	outDir: path.join(process.env.LAPLACE_DESKTOP_BUILD_ROOT, "out"),
	packagerConfig: {
		name: "Laplace",
		executableName: "Laplace",
		appBundleId: "com.withlaplace.desktop",
		appCategoryType: "public.app-category.productivity",
		asar: { unpack: "**/*.node" },
		prune: false,
		icon: path.join(process.env.LAPLACE_DESKTOP_BUILD_ROOT, "resources/icon"),
		extraResource: [path.join(process.env.LAPLACE_DESKTOP_BUILD_ROOT, ".cache/runtime")],
		osxSign: {
			continueOnError: false,
			identity: macIdentity,
			// The local certificate is pinned by fingerprint and trusted only for code signing.
			// osx-sign's discovery uses the broader default Keychain policy.
			identityValidation: !localSigning,
			preAutoEntitlements: false,
			preEmbedProvisioningProfile: false,
			optionsForFile: (filePath) => ({
				hardenedRuntime: !localSigning,
				...(localSigning ? { timestamp: "none" } : {}),
				...(path.basename(filePath) === "point-native"
					? { additionalArguments: ["--identifier", "com.withlaplace.desktop.point"] }
					: {}),
			}),
		},
	},
	makers: [
		{ name: "@electron-forge/maker-zip", platforms: ["darwin", "win32"] },
		{
			name: "@electron-forge/maker-squirrel",
			platforms: ["win32"],
			config: { name: "Laplace", setupExe: "LaplaceSetup.exe", noMsi: true },
		},
	],
};
