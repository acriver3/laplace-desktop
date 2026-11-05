import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import { chromium, expect as browserExpect } from "@playwright/test";
import { expect, it } from "vitest";

// Uses only the built renderer and synthetic IPC; no account, helper, keychain, or native app access.
it.skipIf(
	!existsSync(resolve("dist/renderer/index.html")) || !existsSync(chromium.executablePath()),
)(
	"shows only On this device pages, with sign-in, Back to Laplace, and recovery states",
	async () => {
		const directory = resolve("dist/renderer");
		const server = createServer(async (request, response) => {
			const path = resolve(
				directory,
				"." +
					new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/$/, "/index.html"),
			);
			if (!path.startsWith(directory + sep)) {
				response.writeHead(404).end();
				return;
			}
			try {
				response.setHeader(
					"Content-Type",
					(
						{
							".js": "text/javascript",
							".css": "text/css",
							".html": "text/html",
							".svg": "image/svg+xml",
							".woff2": "font/woff2",
						} as Record<string, string>
					)[extname(path)] ?? "application/octet-stream",
				);
				response.end(await readFile(path));
			} catch {
				response.writeHead(404).end();
			}
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.addInitScript(() => {
				const shell: any = {
					profile: "hosted",
					origin: "https://connect.withlaplace.com",
					mode: "local",
					section: "servers",
					loading: false,
					signIn: "idle",
					browserSignIn: true,
					webShellVersion: 1,
					accounts: [],
				};
				const snapshot: any = {
					mode: "local-only",
					origin: shell.origin,
					endpoint: "http://127.0.0.1:1",
					runId: "synthetic",
					stayLocalOnly: true,
					servers: [
						{
							id: "filesystem",
							name: "Filesystem",
							enabled: true,
							status: "online",
							transport: "stdio",
							command: "synthetic",
							secretKeys: [],
							linkMode: "local-only",
							tools: [],
							diagnostic: [],
						},
					],
					clients: [],
					localTools: [],
					jobs: [],
				};
				// Custom IDs and names may collide with providers and with catalog display names.
				for (const id of ["slack", "slack-personal", "linkedin"]) {
					snapshot.servers.push({ ...snapshot.servers[0], id, name: "Slack" });
				}
				const listeners = new Set<(event: any) => void>();
				const test = {
					history: [] as { method: string; input: any }[],
					copyFails: false,
					update(patch: Record<string, unknown>) {
						Object.assign(shell, patch);
						for (const key of Object.keys(patch)) if (patch[key] === undefined) delete shell[key];
						for (const listener of listeners)
							listener({ event: "shell", data: structuredClone(shell) });
					},
				};
				Object.assign(window, { localShellTest: test });
				Object.defineProperty(navigator, "clipboard", {
					value: {
						async writeText() {
							if (test.copyFails) throw new Error("Clipboard unavailable");
						},
					},
				});
				window.laplaceDesktop = {
					onEvent(listener) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					async invoke(method: string, input?: any): Promise<any> {
						test.history.push({ method, input });
						if (method === "shell.catalogSetup")
							return {
								prompt: "Help me set up Catalog connector using Set up manually.",
								opened: input.action === "open",
							};
						if (method === "shell.status") return structuredClone(shell);
						if (method === "status") return structuredClone(snapshot);
						if (method === "portable.status") return [];
						if (method === "portable.devices")
							return shell.account
								? [
										{
											id: "peer",
											name: "Laptop A",
											online: false,
											connections: [
												{
													id: "22222222-2222-4222-8222-222222222222",
													name: "Offline connector",
													remoteEnabled: false,
													portableReady: true,
												},
											],
										},
									]
								: [];
						if (method === "catalog.list")
							return [
								{
									id: "slack-mcp-server",
									serverId: "slack",
									name: "Slack",
									installed: false,
									available: true,
									fields: [],
									description: "Slack catalog",
								},
								{
									id: "linkedin-mcp-server",
									serverId: "linkedin",
									name: "LinkedIn",
									installed: true,
									available: true,
									fields: [],
									description: "LinkedIn catalog",
								},
								{
									id: "fixture-catalog",
									name: "Catalog connector",
									description: "Synthetic catalog entry",
									available: true,
									fields: [],
								},
							];
						if (method === "shell.updatePreferences") {
							test.update({
								updates: { ...shell.updates, policy: { ...shell.updates?.policy, ...input } },
							});
							return shell;
						}
						if (method === "updates.connectors" || method === "updates.pin")
							return [
								{
									id: "updates-fixture",
									name: "Managed update fixture",
									version: "1.0.0",
									availableVersion: "1.1.0",
									pinned: input?.pinned ?? false,
								},
							];
						if (method === "shell.local") {
							test.update({ mode: "local", section: input.section });
							return structuredClone(shell);
						}
						if (method === "shell.web") {
							test.update({ mode: "web" });
							return structuredClone(shell);
						}
						return structuredClone(shell);
					},
				};
			});
			await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
			const test = (patch: Record<string, unknown>) =>
				page.evaluate((value) => (window as any).localShellTest.update(value), patch);
			const history = () => page.evaluate(() => (window as any).localShellTest.history);
			const navigation = page.getByRole("navigation", { name: "On this device" });

			// Signed out: local pages only, catalog installs available, and a browser sign-in entry point.
			await browserExpect(page.getByRole("heading", { name: "On this device" })).toBeVisible();
			await browserExpect(navigation.getByRole("button")).toHaveText([
				"Connections",
				"AI clients",
				"Device",
				"Updates",
			]);
			await browserExpect(
				navigation.getByRole("button", { name: "Connections", exact: true }),
			).toHaveAttribute("aria-current", "page");
			await browserExpect(page.getByRole("list", { name: "Local connections" })).toContainText(
				"Filesystem",
			);
			const localRows = page.getByRole("list", { name: "Local connections" }).getByRole("listitem");
			await browserExpect(page.getByText("Install connectors", { exact: true })).toHaveCount(0);
			await browserExpect(
				page.getByText("Install several catalog connectors", { exact: true }),
			).toHaveCount(0);
			await browserExpect(localRows.getByText("View details", { exact: true })).toHaveCount(0);
			await browserExpect(
				localRows
					.first()
					.getByRole("button", { name: /Options for/ })
					.locator("svg"),
			).toHaveCount(1);
			for (const id of ["slack", "slack-personal"]) {
				const row = localRows.filter({
					has: page.getByRole("button", { name: `Options for Slack (${id})`, exact: true }),
				});
				await browserExpect(row).toContainText("Custom · 0 tools");
				await browserExpect(row.locator("img")).toHaveCount(0);
			}
			const catalogRow = localRows.filter({ hasText: "Catalog · 0 tools" });
			await browserExpect(catalogRow.locator("img")).toHaveCount(0);
			await page
				.getByRole("button", { name: "Options for Slack (slack-personal)", exact: true })
				.click();
			await browserExpect(page.getByRole("dialog")).toHaveCount(0);
			await browserExpect(
				page.getByRole("menuitem", { name: "Edit connection", exact: true }),
			).toBeVisible();
			await browserExpect(page.getByRole("menuitem", { name: "Stop", exact: true })).toBeVisible();
			await page.getByRole("menuitem", { name: "View details", exact: true }).click();
			await browserExpect(page.getByRole("dialog")).toContainText("Connection ID");
			await browserExpect(page.getByRole("dialog")).toContainText("slack-personal");
			await page.keyboard.press("Escape");
			const search = page.getByRole("searchbox", { name: "Search connections" });
			await search.fill("slack-personal");
			await browserExpect(localRows).toHaveCount(1);
			await search.fill("");
			const available = page.getByRole("list", { name: "Available connections" });
			await browserExpect(available.locator(".connector-row-subtitle")).toHaveCount(0);
			await localRows
				.first()
				.getByRole("button", { name: "Details for Filesystem", exact: true })
				.click();
			await browserExpect(page.getByRole("dialog")).toContainText("Connection ID");
			await page.keyboard.press("Escape");
			await available
				.getByRole("button", { name: "Details for Catalog connector", exact: true })
				.click();
			await browserExpect(page.getByRole("dialog")).toContainText("Synthetic catalog entry");
			await page.keyboard.press("Escape");

			for (const width of [1280, 390]) {
				await page.setViewportSize({ width, height: 900 });
				const row = available.getByRole("listitem").last();
				const name = await row.locator(".connector-row-content").boundingBox();
				const action = await row.getByRole("button", { name: /More setup options/ }).boundingBox();
				const bounds = await row.boundingBox();
				expect(action!.x).toBeGreaterThanOrEqual(bounds!.x);
				expect(action!.y).toBeGreaterThanOrEqual(name!.y + name!.height);
				expect(action!.x + action!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
			}
			await page.setViewportSize({ width: 1280, height: 900 });
			const options = available.getByRole("button", { name: /More setup options/ }).last();
			await options.click();
			await page.getByRole("menuitem", { name: "Install on this device", exact: true }).click();
			expect(
				(await history()).some(
					(item: any) =>
						item.method === "portable.install" && item.input.catalogId === "fixture-catalog",
				),
			).toBe(true);
			const sidebar = page.getByRole("complementary", { name: "Main sidebar" });
			await browserExpect(
				sidebar.getByRole("navigation", { name: "Connector navigation" }).getByRole("button"),
			).toHaveText(["On this device", "Credentials"]);
			for (const [label, target] of [
				["Codex", "codex"],
				["Claude Code", "claude-code"],
				["Other agent", "other"],
			]) {
				await options.click();
				await page.getByRole("menuitem", { name: "Set up with " + label, exact: true }).click();
				expect(
					(await history()).filter((item: any) => item.method === "shell.catalogSetup").at(-1).input
						.target,
				).toBe(target);
			}
			await browserExpect(
				page.getByRole("button", { name: "Copy request", exact: true }),
			).toBeVisible();
			for (const width of [1024, 1280]) {
				await page.setViewportSize({ width, height: 1000 });
				const withinCards = await page.locator(".desktop-catalog-connection").evaluateAll((rows) =>
					rows.every((row) => {
						const card = row.getBoundingClientRect();
						return [...row.querySelectorAll("button")].every((button) => {
							const box = button.getBoundingClientRect();
							return box.left >= card.left && box.right <= card.right;
						});
					}),
				);
				expect(withinCards).toBe(true);
			}
			await options.click();
			await page.getByRole("menuitem", { name: "Set up manually", exact: true }).click();
			await browserExpect(page.getByRole("dialog")).toBeVisible();
			await page.keyboard.press("Escape");

			await navigation.getByRole("button", { name: "AI clients", exact: true }).click();
			await browserExpect(
				navigation.getByRole("button", { name: "AI clients", exact: true }),
			).toHaveAttribute("aria-current", "page");
			await navigation.getByRole("button", { name: "Device", exact: true }).click();
			await browserExpect(
				page.getByRole("button", { name: "Sign in to link a workspace", exact: true }),
			).toBeVisible();

			await test({
				section: "updates",
				updates: { phase: "available", installedVersion: "0.1.9", availableVersion: "0.1.10" },
			});
			await browserExpect(
				page.getByText("Installed version: 0.1.9 · Available: 0.1.10"),
			).toBeVisible();
			expect((await history()).some((entry: any) => entry.method === "shell.updateDownload")).toBe(
				false,
			);
			await browserExpect(
				page.getByLabel("Automatically update Laplace Desktop"),
			).not.toBeChecked();
			await browserExpect(
				page.getByLabel("Automatically update managed connectors"),
			).not.toBeChecked();
			await page.getByLabel("Automatically update managed connectors").check();
			expect(
				(await history()).some(
					(entry: any) =>
						entry.method === "shell.updatePreferences" && entry.input.connectors === true,
				),
			).toBe(true);
			await browserExpect(
				page.getByText("Managed update fixture · Installed 1.0.0 · Available 1.1.0"),
			).toBeVisible();
			await page.getByLabel("Keep this version").check();
			expect(
				(await history()).some(
					(entry: any) => entry.method === "updates.pin" && entry.input.pinned === true,
				),
			).toBe(true);

			await page.getByRole("button", { name: "View changes in 0.1.10" }).click();
			expect((await history()).some((entry: any) => entry.method === "shell.updateChanges")).toBe(
				true,
			);
			await page.getByRole("button", { name: "Download update" }).click();
			expect((await history()).some((entry: any) => entry.method === "shell.updateDownload")).toBe(
				true,
			);
			await test({
				updates: { phase: "ready", installedVersion: "0.1.9", availableVersion: "0.1.10" },
			});
			await browserExpect(page.getByRole("button", { name: "Restart to install" })).toBeVisible();
			await page.getByRole("button", { name: "Not now" }).click();
			expect((await history()).some((entry: any) => entry.method === "shell.updateInstall")).toBe(
				false,
			);
			await test({ section: "device" });

			// Signed in: Back to Laplace hands the window to Connect.
			await test({ account: { id: "user", name: "Ada" }, accounts: [{ id: "a", name: "Team" }] });
			await page.getByRole("button", { name: "Back to Laplace" }).click();
			await browserExpect(
				page.getByRole("status").filter({ hasText: "Opening Laplace" }),
			).toBeVisible();

			// Native Desktop also exposes a copy dropdown for offline Keep local sources.
			await test({ mode: "local", section: "servers" });
			const peers = page.getByRole("region", { name: "Connectors on your other devices" });
			await browserExpect(peers).toContainText("Laptop A (Offline)");
			await peers.getByText("Actions", { exact: true }).click();
			await peers.getByRole("button", { name: "Make local copy", exact: true }).click();
			expect(
				(await history()).some(
					(entry: any) =>
						entry.method === "portable.copy" &&
						entry.input.sourceId === "22222222-2222-4222-8222-222222222222",
				),
			).toBe(true);
			await browserExpect(peers.getByRole("status")).toContainText("fresh sign-in");

			// Load failures return to local pages with a retry, keeping local tools usable.
			await test({
				mode: "local",
				webError: "Laplace could not load. Check your internet connection and retry.",
			});
			await browserExpect(page.getByRole("alert")).toContainText("Laplace could not load");
			await page.getByRole("button", { name: "Retry", exact: true }).click();
			await browserExpect(page.getByText("Signed in as Ada")).toBeVisible();

			// Servers without full-web support keep Desktop local with an explanation.
			await test({ webError: undefined, webShellVersion: 0 });
			await browserExpect(page.getByRole("button", { name: "Back to Laplace" })).toBeDisabled();
			await browserExpect(page.getByText(/needs an update to open in Desktop/)).toBeVisible();

			const methods = (await history()).map((entry: any) => entry.method);
			expect(methods).toContain("shell.web");
			expect(methods).toContain("shell.reload");
			expect(methods.filter((method: string) => method === "shell.local")).toHaveLength(3);
			expect(
				methods.filter((method: string) =>
					[
						"shell.accountData",
						"shell.navigate",
						"shell.viewport",
						"shell.selectWorkspace",
					].includes(method),
				),
			).toEqual([]);
			expect(errors).toEqual([]);
		} finally {
			await browser.close();
			await new Promise<void>((done) => server.close(() => done()));
		}
	},
	30000,
);
