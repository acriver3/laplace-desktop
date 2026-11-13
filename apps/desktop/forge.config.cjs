const path = require("node:path");
const macIdentity = process.env.LAPLACE_MAC_SIGN_IDENTITY || "-";

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
			identity: macIdentity,
			identityValidation: macIdentity !== "-",
			preAutoEntitlements: false,
			preEmbedProvisioningProfile: false,
			optionsForFile: (filePath) => ({
				hardenedRuntime: macIdentity !== "-",
				...(macIdentity === "-" ? { timestamp: "none" } : {}),
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
