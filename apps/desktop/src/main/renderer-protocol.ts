import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { net, type Session } from "electron";

/** Custom protocol handlers belong to a session, including isolated overlays. */
export function registerRendererProtocol(context: Session, appRoot: string) {
	const root = join(appRoot, "renderer");
	context.protocol.handle("laplace-desktop", async (request) => {
		try {
			const url = new URL(request.url);
			const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
			if (
				url.host !== "app" ||
				request.method !== "GET" ||
				!file.startsWith(root + sep) ||
				![".html", ".js", ".css", ".svg", ".png", ".webp", ".jpg", ".woff2"].includes(extname(file))
			)
				return new Response("Not found", { status: 404 });
			return await net.fetch(pathToFileURL(file).href);
		} catch {
			return new Response("Not found", { status: 404 });
		}
	});
}
