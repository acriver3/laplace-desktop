import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

export const browserHostName = "com.laplace.browser";
export const browserRequest = z
	.object({
		id: z.string().uuid(),
		sessionRecoveryV1: z.boolean().optional(),
		provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
		environment: z.string().max(80),
		workspace: z.string().url().max(2048),
		pairingUrl: z
			.string()
			.max(256)
			.refine((value) => {
				try {
					const url = new URL(value);
					return (
						url.protocol === "http:" &&
						url.hostname === "127.0.0.1" &&
						!!url.port &&
						!url.username &&
						!url.password &&
						url.pathname === "/" &&
						!url.search &&
						/^#[A-Za-z0-9_-]{43}$/.test(url.hash)
					);
				} catch {
					return false;
				}
			}),
		expiresAt: z.string().datetime(),
	})
	.strict();
export type BrowserRequest = z.infer<typeof browserRequest>;
export const browserRequestDirectory = () =>
	join(homedir(), ".laplace-desktop", "browser-requests");
/** Only ephemeral local rendezvous tickets, never provider credentials. */
export async function publishBrowserRequest(
	value: BrowserRequest,
	directory = browserRequestDirectory(),
) {
	const request = browserRequest.parse(value);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${request.id}.json`),
		temporary = join(directory, `${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify(request), { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
	return () => rm(path, { force: true });
}
export async function listBrowserRequests(directory = browserRequestDirectory()) {
	const requests: BrowserRequest[] = [];
	const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
	for (const file of files.slice(0, 256)) {
		if (!file.isFile() || !/^[0-9a-f-]{36}\.json$/.test(file.name)) continue;
		try {
			const text = await readFile(join(directory, file.name), "utf8");
			if (text.length > 4096) continue;
			const request = browserRequest.parse(JSON.parse(text));
			if (
				file.name !== `${request.id}.json` ||
				Date.parse(request.expiresAt) <= Date.now() ||
				Date.parse(request.expiresAt) > Date.now() + 11 * 60_000
			)
				continue;
			requests.push(request);
			if (requests.length === 16) break;
		} catch {
			/* Ignore stale or invalid tickets; never return their raw contents. */
		}
	}
	return requests;
}
