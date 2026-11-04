import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname, sep } from "node:path";

import { chromium, expect as browserExpect } from "@playwright/test";
import { expect, it } from "vitest";

// Run after a desktop build. No real helper, vault, keychain, or agent configurations are used.
it.skipIf(
	!existsSync(resolve("dist/renderer/index.html")) || !existsSync(chromium.executablePath()),
)(
	"keeps broker actions inside cards and dismisses stale setup notices across reloads",
	async () => {
		const directory = resolve("dist/renderer");
		const server = createServer(async (req, res) => {
			const file = resolve(
				directory,
				"." + new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/$/, "/index.html"),
			);
			if (!file.startsWith(directory + sep)) {
				res.writeHead(404).end();
				return;
			}
			try {
				res.setHeader(
					"Content-Type",
					(
						{
							".js": "text/javascript",
							".css": "text/css",
							".html": "text/html",
							".woff2": "font/woff2",
						} as Record<string, string>
					)[extname(file)] ?? "application/octet-stream",
				);
				res.end(await readFile(file));
			} catch {
				res.writeHead(404).end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.addInitScript(() => {
				const catalog = ["Y Combinator", "Outlook", "Yale SOM Alumni", "Slack"].map(
					(name, index) => ({
						id: String(index),
						name,
						description: name,
						available: true,
						fields: [],
						installed: index === 0,
						serverId: "yc",
					}),
				);
				const shell = {
					profile: "hosted",
					origin: "https://connect.withlaplace.com",
					mode: "local",
					section: "servers",
					webShellVersion: 1,
					loading: false,
					signIn: "idle",
					browserSignIn: true,
					accounts: [],
				};
				const snapshot = {
					mode: "local-only",
					origin: shell.origin,
					endpoint: "http://localhost:1234/mcp",
					servers: [{ id: "yc", name: "Y Combinator", tools: [], status: "online", enabled: true }],
					clients: [],
					localTools: [],
					runId: "fixture",
					jobs: [
						{
							id: "done",
							status: "completed",
							connectorName: "YC",
							kind: "authenticate",
							message: "Old successful setup",
						},
						{
							id: "failed",
							status: "failed",
							connectorName: "Outlook",
							kind: "authenticate",
							message: "Old failed setup",
						},
					],
				};
				(window as any).laplaceDesktop = {
					onEvent: () => () => {},
					invoke: async (method: string) => {
						if (method === "shell.status") return shell;
						if (method === "status") return snapshot;
						if (method === "catalog.list") return catalog;
						if (method === "broker.enabled") return { enabled: true };
						if (method === "portable.devices") return [];
						if (method === "portable.status")
							return [
								{
									id: "ready",
									name: "YC",
									status: "ready",
									message: "Already connected",
									connectorId: "yc",
								},
								{
									id: "cancelled",
									name: "Outlook",
									status: "cancelled",
									message: "Old cancellation",
									connectorId: "outlook",
								},
							];
						return {};
					},
				};
			});
			await page.goto(`http://127.0.0.1:${port}`);
			await browserExpect(
				page.getByRole("button", { name: "Connect with assistant", exact: true }),
			).toHaveCount(3);
			await browserExpect(page.getByText("Old successful setup")).toHaveCount(0);
			await browserExpect(page.getByText("Already connected")).toHaveCount(0);
			await browserExpect(page.getByText("Old failed setup")).not.toBeVisible();
			await browserExpect(page.getByText("Old cancellation")).not.toBeVisible();
			await page.getByText("Setup activity (1)", { exact: true }).click();
			await page.getByRole("button", { name: "Dismiss Outlook authenticate notification" }).click();
			await page.getByText("Connection setup (1)", { exact: true }).click();
			await page.getByRole("button", { name: "Dismiss Outlook setup" }).click();
			await page.reload();
			await browserExpect(
				page.getByRole("button", { name: "Connect with assistant", exact: true }),
			).toHaveCount(3);
			await browserExpect(page.getByText("Old failed setup")).toHaveCount(0);
			await browserExpect(page.getByText("Old cancellation")).toHaveCount(0);
			for (const width of [1440, 900, 600, 390]) {
				await page.setViewportSize({ width, height: 1000 });
				const overflow = await page.locator(".desktop-connection").evaluateAll((cards) =>
					cards.flatMap((card) => {
						const bounds = card.getBoundingClientRect();
						return [...card.querySelectorAll("button, .connector-row-title")]
							.filter((element) => {
								const r = element.getBoundingClientRect();
								return (
									r.width > 0 &&
									(r.left < bounds.left - 1 ||
										r.right > bounds.right + 1 ||
										r.bottom > bounds.bottom + 1)
								);
							})
							.map((element) => element.textContent);
					}),
				);
				expect(overflow).toEqual([]);
			}
			await page
				.getByRole("button", { name: "Connect with assistant", exact: true })
				.first()
				.click();
			await browserExpect(page.getByRole("dialog")).toBeVisible();
			await page.getByRole("button", { name: "Close dialog" }).click();
			await page.setViewportSize({ width: 1440, height: 1000 });
			await page.screenshot({ path: resolve(".cache/connection-layout.png"), fullPage: true });
			expect(errors).toEqual([]);
		} finally {
			await browser.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
	60000,
);
