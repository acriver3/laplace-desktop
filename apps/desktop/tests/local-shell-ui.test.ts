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
			page.setDefaultTimeout(5000);
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
				const point = {
					available: true,
					registered: false,
					phase: "idle",
					settings: { enabled: false, shortcut: "Control+L", destination: "codex-desktop" },
					permissions: { screen: "granted", accessibility: true },
				};
				const test = {
					catalogFails: true,
					catalogEmpty: false,
					catalogAllInstalled: false,
					finishCatalogLoad: () => {},
					history: [] as { method: string; input: any }[],
					copyFails: false,
					copied: "",
					launchOpened: true,
					launchFails: false,
					emit(event: string, data: unknown) {
						for (const listener of listeners) listener({ event, data });
					},
					updatePoint(patch: Record<string, unknown>) {
						Object.assign(point, patch);
						for (const listener of listeners)
							listener({ event: "point", data: structuredClone(point) });
					},
					update(patch: Record<string, unknown>) {
						Object.assign(shell, patch);
						for (const key of Object.keys(patch)) if (patch[key] === undefined) delete shell[key];
						for (const listener of listeners)
							listener({ event: "shell", data: structuredClone(shell) });
					},
				};
				const catalogGate = new Promise<void>((resolve) => { test.finishCatalogLoad = resolve; });
				Object.assign(window, { localShellTest: test });
				Object.defineProperty(navigator, "clipboard", {
					value: {
						async writeText(value: string) {
							if (test.copyFails) throw new Error("Clipboard unavailable");
							test.copied = value;
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
						if (method === "shell.point.status") return structuredClone(point);
						if (method === "shell.point.configure") {
							test.updatePoint({ settings: input, registered: input.enabled });
							return structuredClone(point);
						}
						if (method === "shell.point.capture") {
							test.updatePoint({ phase: "capturing" });
							return structuredClone(point);
						}
						if (method === "shell.catalogSetup") {
							if (test.launchFails) throw new Error("Synthetic launch failure");
							return {
								prompt: `Set up ${input.catalogId}${input.connectionId ? " using " + input.connectionId : ""} with Laplace.`,
								opened: test.launchOpened && input.target !== "other",
							};
						}
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
						if (method === "catalog.list") {
							await catalogGate;
							if (test.catalogFails) throw new Error("Local work is active; update deferred");
							if (test.catalogEmpty) return [];
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
							].map((entry) => test.catalogAllInstalled ? { ...entry, installed: true } : entry);
						}
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

			// Failed initial loads must not look like a fully installed catalog. Refresh must
			// retry even when status returns the exact same endpoint, run ID and servers.
			await browserExpect(page.getByText("Loading available connections…")).toBeVisible();
			await browserExpect(page.getByText("Every catalog connection is installed.")).toHaveCount(0);
			await page.evaluate(() => (window as any).localShellTest.finishCatalogLoad());
			await browserExpect(page.getByRole("alert")).toContainText("Couldn’t load available connections.");
			await browserExpect(page.getByText("Every catalog connection is installed.")).toHaveCount(0);
			await page.evaluate(() => { (window as any).localShellTest.catalogFails = false; });
			await page.getByRole("button", { name: "Retry catalog" }).click();
			await browserExpect(page.getByRole("list", { name: "Available connections" })).toContainText("Slack");
			await page.evaluate(() => { (window as any).localShellTest.catalogFails = true; });
			await page.getByRole("button", { name: "Refresh connections" }).click();
			await browserExpect(page.getByRole("button", { name: "Retry catalog" })).toBeVisible();
			await browserExpect(page.getByRole("list", { name: "Available connections" })).toContainText("Slack");
			await page.evaluate(() => { Object.assign((window as any).localShellTest, { catalogFails: false, catalogEmpty: true }); });
			await page.getByRole("button", { name: "Retry catalog" }).click();
			await browserExpect(page.getByText("No catalog connections are available.")).toBeVisible();
			await browserExpect(page.getByText("Every catalog connection is installed.")).toHaveCount(0);
			await page.evaluate(() => { Object.assign((window as any).localShellTest, { catalogEmpty: false, catalogAllInstalled: true }); });
			await page.getByRole("button", { name: "Refresh connections" }).click();
			await browserExpect(page.getByText("Every catalog connection is installed.")).toBeVisible();
			await page.evaluate(() => { (window as any).localShellTest.catalogAllInstalled = false; });
			await page.getByRole("button", { name: "Refresh connections" }).click();
			await browserExpect(page.getByRole("list", { name: "Available connections" })).toContainText("Slack");

			// Signed out: local pages only, catalog installs available, and a browser sign-in entry point.
			await browserExpect(page.getByRole("heading", { name: "On this device" })).toBeVisible();
			await browserExpect(navigation.getByRole("button")).toHaveText([
				"Connections",
				"AI clients",
				"Info",
				"Tools",
				"Settings",
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
				const action = await row.getByRole("button", { name: /Change agent/ }).boundingBox();
				const bounds = await row.boundingBox();
				expect(action!.x).toBeGreaterThanOrEqual(bounds!.x);
				expect(action!.y).toBeGreaterThanOrEqual(bounds!.y);
				expect(action!.y + action!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
				expect(action!.x >= name!.x + name!.width || action!.y >= name!.y + name!.height).toBe(
					true,
				);
				expect(bounds!.height).toBeLessThan(180);
				expect(action!.x + action!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
			}
			await page.setViewportSize({ width: 1280, height: 900 });
			const catalogRowAction = available.getByRole("listitem").last();
			const connect = catalogRowAction.getByRole("button", { name: "Connect", exact: true });
			const changeAgent = catalogRowAction.getByRole("button", { name: /Change agent/ });
			const sidebar = page.getByRole("complementary", { name: "Main sidebar" });
			await browserExpect(
				sidebar.getByRole("navigation", { name: "Connector navigation" }).getByRole("button"),
			).toHaveText(["On this device", "Credentials"]);
			await connect.click();
			await browserExpect(page.getByRole("dialog")).toHaveCount(0);
			await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
			await browserExpect(catalogRowAction.getByRole("status")).toHaveText(
				"Review and send the draft in your agent.",
			);
			let setup = (await history()).filter((item: any) => item.method === "shell.catalogSetup");
			expect(setup).toHaveLength(1);
			expect(setup[0].input).toEqual({
				catalogId: "fixture-catalog",
				target: "codex",
				action: "open",
			});
			await connect.click();
			await browserExpect(page.getByRole("menu")).toHaveCount(0);
			expect(
				(await history()).filter((item: any) => item.method === "shell.catalogSetup"),
			).toHaveLength(2);

			await changeAgent.click();
			await page.getByRole("menuitem", { name: "Other agent", exact: true }).click();
			expect(
				(await history()).filter((item: any) => item.method === "shell.catalogSetup"),
			).toHaveLength(2);
			await connect.click();
			await browserExpect(catalogRowAction.getByRole("status")).toHaveText(
				"Copy this request into your agent.",
			);
			await page.evaluate(() => {
				(window as any).localShellTest.copyFails = true;
			});
			await catalogRowAction.getByRole("button", { name: "Copy request", exact: true }).click();
			await browserExpect(catalogRowAction.getByRole("alert")).toContainText("Could not copy");
			await catalogRowAction.getByText("View request", { exact: true }).click();
			await browserExpect(catalogRowAction.locator("pre")).toContainText("fixture-catalog");
			await page.evaluate(() => {
				(window as any).localShellTest.copyFails = false;
			});
			await catalogRowAction.getByRole("button", { name: "Copy request", exact: true }).click();
			expect(await page.evaluate(() => (window as any).localShellTest.copied)).toContain(
				"fixture-catalog",
			);
			await browserExpect(catalogRowAction.getByRole("status")).toContainText("Request copied");

			await changeAgent.click();
			await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
			await page.evaluate(() => {
				(window as any).localShellTest.launchOpened = false;
			});
			await connect.click();
			await browserExpect(catalogRowAction.getByRole("status")).toHaveText(
				"Copy this request into your agent.",
			);
			await page.evaluate(() => {
				(window as any).localShellTest.launchFails = true;
			});
			await connect.click();
			await browserExpect(catalogRowAction.getByRole("alert")).toContainText("Refresh connections");
			await page.evaluate(() => {
				(window as any).localShellTest.launchFails = false;
			});
			await changeAgent.click();
			await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();

			for (const width of [390, 1280]) {
				await page.setViewportSize({ width, height: 1000 });
				await available.scrollIntoViewIfNeeded();
				await page.screenshot({
					path: resolve(`.cache/agent-led-connections-${width}.png`),
					animations: "disabled",
					fullPage: true,
				});
			}
			await page.setViewportSize({ width: 1280, height: 1000 });

			const linkedRow = localRows.filter({
				has: page.getByRole("button", { name: "Options for Slack (linkedin)", exact: true }),
			});
			await linkedRow.getByRole("button", { name: "Details for Slack", exact: true }).click();
			const details = page.getByRole("dialog");
			await browserExpect(
				details.getByRole("button", { name: "Authenticate", exact: true }),
			).toHaveCount(0);
			await browserExpect(
				details.getByRole("button", { name: "Verify connection", exact: true }),
			).toHaveCount(0);
			await details.getByRole("button", { name: "Reconnect", exact: true }).click();
			setup = (await history()).filter((item: any) => item.method === "shell.catalogSetup");
			expect(setup.at(-1).input).toEqual({
				catalogId: "linkedin-mcp-server",
				connectionId: "linkedin",
				target: "claude-code",
				action: "open",
			});
			await page.keyboard.press("Escape");
			await page.evaluate(() =>
				(window as any).localShellTest.emit("browser-approval", "pending-request"),
			);
			await browserExpect(page.getByRole("dialog")).toHaveCount(0);
			const setupMutations = (await history()).filter((item: any) =>
				[
					"portable.install",
					"catalog.install",
					"catalog.authenticate",
					"catalog.verify",
					"broker.stage",
					"shell.brokerSetup",
					"browser.list",
					"browser.review",
					"broker.list",
				].includes(item.method),
			);
			expect(setupMutations).toEqual([]);

			await navigation.getByRole("button", { name: "AI clients", exact: true }).click();
			await browserExpect(
				navigation.getByRole("button", { name: "AI clients", exact: true }),
			).toHaveAttribute("aria-current", "page");
			await navigation.getByRole("button", { name: "Info", exact: true }).click();
			await browserExpect(page.getByRole("region", { name: "Device information" })).toContainText(
				"OS keychain",
			);
			await browserExpect(page.getByRole("region", { name: "Laplace Point settings" })).toHaveCount(
				0,
			);
			for (const width of [390, 1280]) {
				await page.setViewportSize({ width, height: 1000 });
				await page.screenshot({ path: resolve(`.cache/desktop-info-${width}.png`) });
			}
			await navigation.getByRole("button", { name: "Settings", exact: true }).click();
			await browserExpect(
				page.getByRole("button", { name: "Sign in to link a workspace", exact: true }),
			).toBeVisible();
			await browserExpect(page.getByRole("region", { name: "Update settings" })).toHaveCount(0);
			await page.getByLabel("Environment", { exact: true }).selectOption("local");
			expect(
				(await history()).find((entry: any) => entry.method === "shell.profile").input,
			).toEqual({ profile: "local" });
			for (const width of [390, 1280]) {
				await page.setViewportSize({ width, height: 1000 });
				await page.screenshot({ path: resolve(`.cache/desktop-settings-${width}.png`) });
			}
			await navigation.getByRole("button", { name: "Tools", exact: true }).click();
			const pointPanel = page.getByRole("region", { name: "Laplace Point settings", exact: true });
			await browserExpect(page.getByRole("region", { name: "Workspace settings" })).toHaveCount(0);
			await browserExpect(page.getByRole("tooltip")).toHaveCount(0);
			await pointPanel.getByRole("button", { name: "About Default agent", exact: true }).hover();
			await browserExpect(page.getByRole("tooltip")).toContainText(
				"Codex desktop attaches to the current draft",
			);
			await page.keyboard.press("Escape");
			await browserExpect(page.getByRole("tooltip")).toHaveCount(0);
			await browserExpect(
				pointPanel.getByRole("button", { name: "Capture with Point", exact: true }),
			).toBeDisabled();
			expect((await history()).some((entry: any) => entry.method === "shell.point.configure")).toBe(
				false,
			);
			await pointPanel.getByRole("checkbox", { name: "Enable Laplace Point", exact: true }).check();
			await pointPanel.getByLabel("Default agent", { exact: true }).selectOption("claude-cli");
			await pointPanel.getByLabel("Capture shortcut", { exact: true }).fill("Control+Shift+P");
			await pointPanel.getByRole("button", { name: "Save shortcut", exact: true }).click();
			expect(
				(await history()).filter((entry: any) => entry.method === "shell.point.configure").at(-1)
					.input,
			).toEqual({ enabled: true, destination: "claude-cli", shortcut: "Control+Shift+P" });
			await pointPanel.getByRole("button", { name: "Capture with Point", exact: true }).click();
			await browserExpect(
				pointPanel.getByRole("button", { name: "Capture with Point", exact: true }),
			).toBeDisabled();
			await page.evaluate(() => (window as any).localShellTest.updatePoint({ phase: "idle" }));
			for (const width of [390, 1280]) {
				await page.setViewportSize({ width, height: 1000 });
				await pointPanel.scrollIntoViewIfNeeded();
				expect(
					await pointPanel.evaluate((element) => {
						const bounds = element.getBoundingClientRect();
						return bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
					}),
				).toBe(true);
				const toggle = pointPanel.locator(".desktop-setting-toggle");
				const checkbox = await toggle.getByRole("checkbox").boundingBox();
				const copy = await toggle.locator(".desktop-setting-copy").boundingBox();
				expect(checkbox!.x).toBeGreaterThan(copy!.x + copy!.width);
				await pointPanel.screenshot({
					path: resolve(`.cache/desktop-point-${width}.png`),
					animations: "disabled",
				});
			}
			await page.setViewportSize({ width: 1280, height: 1000 });

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
				page.getByLabel("Enable Automatic Updates", { exact: true }),
			).not.toBeChecked();
			await browserExpect(
				page.getByLabel("Enable Automatic Connector Updates", { exact: true }),
			).not.toBeChecked();
			const updateHint = page.getByRole("button", {
				name: "About Enable Automatic Updates",
				exact: true,
			});
			await page.getByLabel("Enable Automatic Updates", { exact: true }).focus();
			await page.keyboard.press("Shift+Tab");
			await browserExpect(updateHint).toBeFocused();
			await browserExpect(page.getByRole("tooltip")).toContainText(
				"15 minutes of computer inactivity",
			);
			await page.keyboard.press("Escape");
			await browserExpect(page.getByRole("tooltip")).toHaveCount(0);
			expect(
				(await history()).filter((entry: any) => entry.method === "shell.updatePreferences"),
			).toHaveLength(0);
			await page.getByLabel("Enable Automatic Updates", { exact: true }).check();
			await page.getByLabel("Enable Automatic Connector Updates", { exact: true }).check();
			expect(
				(await history()).some(
					(entry: any) =>
						entry.method === "shell.updatePreferences" && entry.input.connectors === true,
				),
			).toBe(true);
			await browserExpect(page.getByText("Managed update fixture", { exact: true })).toBeVisible();
			await browserExpect(
				page.getByText("Installed 1.0.0 · Available 1.1.0", { exact: true }),
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
			const updatesPanel = page.getByRole("region", { name: "Update settings", exact: true });
			for (const width of [390, 1280]) {
				await page.setViewportSize({ width, height: 1000 });
				await updatesPanel.scrollIntoViewIfNeeded();
				expect(
					await updatesPanel.evaluate((element) => {
						const bounds = element.getBoundingClientRect();
						return bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
					}),
				).toBe(true);
				for (const toggle of await updatesPanel.locator(".desktop-setting-toggle").all()) {
					const checkbox = await toggle.getByRole("checkbox").boundingBox();
					const copy = await toggle.locator(".desktop-setting-copy").boundingBox();
					expect(checkbox!.x).toBeGreaterThan(copy!.x + copy!.width);
				}
				await updatesPanel.screenshot({
					path: resolve(`.cache/desktop-updates-${width}.png`),
					animations: "disabled",
				});
			}
			await page.setViewportSize({ width: 1280, height: 1000 });
			await browserExpect(page.getByRole("button", { name: "Restart to install" })).toBeVisible();
			await browserExpect(page.getByRole("button", { name: "Not now" })).toHaveCount(0);
			await navigation.getByRole("button", { name: "Connections", exact: true }).click();
			expect((await history()).some((entry: any) => entry.method === "shell.updateInstall")).toBe(
				false,
			);
			await test({ section: "device" });
			await browserExpect(
				navigation.getByRole("button", { name: "Settings", exact: true }),
			).toHaveAttribute("aria-current", "page");
			await browserExpect(page.getByRole("region", { name: "Workspace settings" })).toBeVisible();

			// Signed in: Back to Laplace hands the window to Connect.
			await test({ account: { id: "user", name: "Ada" }, accounts: [{ id: "a", name: "Team" }] });
			await page.getByLabel("Workspace to link", { exact: true }).selectOption("a");
			await page.getByRole("button", { name: "Link workspace", exact: true }).click();
			expect((await history()).find((entry: any) => entry.method === "shell.link").input).toEqual({
				accountId: "a",
				name: "Laplace Desktop",
			});
			await page.getByRole("button", { name: "Back to Laplace" }).click();
			await browserExpect(
				page.getByRole("status").filter({ hasText: "Opening Laplace" }),
			).toBeVisible();

			// Local connections show only this runtime, without legacy CLI/Desktop peers.
			await test({ mode: "local", section: "servers" });
			await browserExpect(
				page.getByRole("region", { name: "Connectors on your other devices" }),
			).toHaveCount(0);
			await browserExpect(
				page.getByRole("button", { name: "Connect selected with assistant" }),
			).toHaveCount(0);

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
			expect(
				(await history())
					.filter((entry: any) => entry.method === "shell.local")
					.map((entry: any) => entry.input.section),
			).toEqual(["clients", "info", "settings", "tools", "servers"]);
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
			await page.reload();
			await page.evaluate(() => {
				(window as any).localShellTest.catalogFails = false;
				(window as any).localShellTest.finishCatalogLoad();
			});
			await available
				.getByRole("listitem")
				.last()
				.getByRole("button", { name: "Connect", exact: true })
				.click();
			await browserExpect(page.getByRole("menu")).toHaveCount(0);
			expect(
				(await history()).find((item: any) => item.method === "shell.catalogSetup").input.target,
			).toBe("claude-code");
			expect(errors).toEqual([]);
		} finally {
			await browser.close();
			await new Promise<void>((done) => server.close(() => done()));
		}
	},
	30000,
);
