import { defineConfig } from "vite";

export default defineConfig({
	root: "src/renderer",
	base: "./",
	oxc: { jsx: { runtime: "automatic" } },
	resolve: { dedupe: ["react", "react-dom"] },
	build: {
		outDir: "../../dist/renderer",
		emptyOutDir: true,
		rollupOptions: { input: { main: "src/renderer/index.html", point: "src/renderer/point.html" } },
	},
	server: { host: "127.0.0.1", port: 43190, strictPort: true },
});
