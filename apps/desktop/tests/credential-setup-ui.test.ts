import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname, sep } from "node:path";

import { chromium, expect as browserExpect } from "@playwright/test";
import { credentialSettings } from "@repo/project-protocol/credentials";
import { expect, it } from "vitest";

// Run after a desktop build. No real helper, vault, keychain, or agent configurations are used.
it.skipIf(
	!existsSync(resolve("dist/renderer/index.html")) || !existsSync(chromium.executablePath()),
)(
	"completes guided setup and unlock with synthetic IPC, without technical fields in the normal flow",
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
			const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await page.addInitScript(
				({ settings }) => {
					const client = {
						id: "00000000-0000-4000-8000-000000000001",
						name: "Codex",
						enabled: true,
						createdAt: "2026-01-01",
						hosted: "disconnected",
					};
					const credential: any = {
						settings,
						connection: {
							mode: "legacy",
							phase: "disconnected",
							server: "https://vault.bitwarden.com",
						},
						browser: { available: false, owned: false },
						hostedState: "disabled",
						unlocked: false,
						pending: [],
						grants: [],
					};
					const shell: any = {
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
						servers: [],
						clients: [client],
						localTools: [],
						jobs: [],
						runId: "synthetic",
						stayLocalOnly: true,
					};
					const history: string[] = [];
					Object.assign(window, { credentialTest: { credential, history } });
					const listeners = new Set<(event: any) => void>();
					window.laplaceDesktop = {
						onEvent: (listener) => {
							listeners.add(listener);
							return () => listeners.delete(listener);
						},
						invoke: async (method: string, input?: any): Promise<any> => {
							history.push(method);
							if (method === "shell.local") {
								shell.section = input.section;
								for (const listener of listeners)
									listener({ event: "shell", data: structuredClone(shell) });
								return structuredClone(shell);
							}
							if (method === "shell.status") return structuredClone(shell);
							if (method === "status") return structuredClone(snapshot);
							if (method === "credentials.prepare") {
								credential.settings = {
									...credential.settings,
									enabled: true,
									managedBitwarden: true,
									setupStep: "signIn",
								};
								credential.connection.mode = "managed";
								credential.connection.phase = "ready";
							}
							if (method === "credentials.signIn") {
								credential.connection.phase = "challenge";
								credential.connection.challenge = "code";
							}
							if (method === "credentials.answer") {
								if (input.value !== "123456") throw new Error("Wrong synthetic code");
								credential.connection.phase = "connected";
								delete credential.connection.challenge;
								credential.connection.account = "synthetic@example.invalid";
								credential.unlocked = true;
								credential.settings.setupStep = "logins";
							}
							if (method === "credentials.save" || method === "credentials.configure")
								credential.settings = input.settings;
							if (method === "credentials.items")
								return [
									{
										id: "00000000-0000-4000-8000-000000000002",
										label: "Example login",
										origins: ["https://example.invalid"],
									},
									...Array.from({ length: 100 }, (_, i) => ({
										id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
										label: `Other login ${i}`,
										origins: ["https://other.invalid"],
									})),
								];
							if (method === "credentials.browsers") return [];
							if (method === "credentials.lock") credential.unlocked = false;
							if (method === "credentials.unlock") {
								if (input.password !== "synthetic-master")
									return {
										error: { code: "incorrect_password", message: "Incorrect synthetic password" },
									};
								credential.unlocked = true;
							}
							if (method === "credentials.disconnect") {
								credential.settings.enabled = false;
								credential.settings.setupComplete = false;
								credential.connection.phase = "disconnected";
								credential.unlocked = false;
							}
							if (method.startsWith("credentials.")) return structuredClone(credential);
							return [];
						},
					};
				},
				{ settings: credentialSettings.parse({}) },
			);
			await page.goto(`http://127.0.0.1:${port}`);
			await page.getByRole("button", { name: "Credentials", exact: true }).click();
			const panel = page.getByRole("region", { name: "Bitwarden", exact: true });
			await browserExpect(
				panel.getByRole("heading", { name: "Connect your Bitwarden account" }),
			).toBeVisible();
			await browserExpect(
				panel.getByText("Bitwarden CLI override", { exact: false }),
			).not.toBeVisible();
			await page.screenshot({
				path: resolve(".cache/bitwarden-guided-connect.png"),
				fullPage: true,
			});
			await panel.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
			await panel.getByLabel("Email address").fill("synthetic@example.invalid");
			await panel.getByLabel("Master password", { exact: true }).fill("synthetic-master");
			await browserExpect(panel.getByLabel("Master password", { exact: true })).toHaveAttribute(
				"type",
				"password",
			);
			await panel.getByRole("button", { name: "Sign in", exact: true }).click();
			await panel.getByLabel("Verification code", { exact: true }).fill("123456");
			await panel.getByRole("button", { name: "Continue", exact: true }).click();
			await browserExpect(
				panel.getByRole("heading", { name: "Which logins can your assistants use?" }),
			).toBeVisible();
			await panel.getByLabel("Search logins").fill("Example");
			await panel.getByRole("checkbox", { name: /Example login/ }).check();
			await browserExpect(panel.getByText("1 selected · Changes save automatically")).toBeVisible();
			const originalId = await page.evaluate(
				() => (window as any).credentialTest.credential.settings.bindings[0].id,
			);
			await panel.getByRole("button", { name: "Select all logins (101)", exact: true }).click();
			await browserExpect(
				panel.getByText("101 selected · Changes save automatically"),
			).toBeVisible();
			await browserExpect(
				panel.getByRole("button", { name: "All logins selected" }),
			).toBeDisabled();
			const selection = await page.evaluate(
				() => (window as any).credentialTest.credential.settings.bindings,
			);
			expect(selection[0].id).toBe(originalId);
			expect(new Set(selection.map((b: any) => b.itemId)).size).toBe(101);
			expect(
				await page.evaluate(
					() =>
						(window as any).credentialTest.history.filter((m: string) => m === "credentials.save")
							.length,
				),
			).toBe(2);

			expect(await page.evaluate(() => (window as any).credentialTest.credential.unlocked)).toBe(
				true,
			);
			await panel.getByRole("button", { name: "Continue", exact: true }).click();
			await panel.getByRole("checkbox", { name: /Codex/ }).check();
			await panel.getByRole("button", { name: "Finish setup" }).click();
			await browserExpect(panel.getByRole("button", { name: "Manage saved logins" })).toBeVisible();
			for (const title of [
				"Doppler",
				"Recent requests",
				"Assistant access",
				"Chrome readiness",
				"Advanced settings",
			]) {
				await browserExpect(page.getByText(title, { exact: true })).toHaveCount(0);
			}
			expect(
				await page.evaluate(() =>
					(window as any).credentialTest.history.filter(
						(method: string) =>
							method.startsWith("credentials.chrome") || method === "credentials.browsers",
					),
				),
			).toEqual([]);
			await panel.getByRole("button", { name: "Lock Bitwarden", exact: true }).click();
			await panel.getByLabel("Master password", { exact: true }).fill("synthetic-master");
			await panel.getByRole("button", { name: "Unlock Bitwarden", exact: true }).click();
			await browserExpect(
				panel.getByRole("button", { name: "Lock Bitwarden", exact: true }),
			).toBeVisible();
			await page.screenshot({
				path: resolve(".cache/bitwarden-guided-overview.png"),
				fullPage: true,
			});
			for (const width of [390, 1280]) {
				await page.setViewportSize({ width, height: 1000 });
				expect(
					await panel.evaluate((element) => {
						const bounds = element.getBoundingClientRect();
						return bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
					}),
				).toBe(true);
				await page.screenshot({
					path: resolve(`.cache/agent-led-credentials-${width}.png`),
					fullPage: true,
				});
			}
			// Earlier installations may have stopped at the removed Chrome step.
			const permissions = await page.evaluate(() => {
				const credential = (window as any).credentialTest.credential;
				credential.settings.setupComplete = false;
				credential.settings.setupStep = "browser";
				return {
					clients: credential.settings.clients,
					bindings: credential.settings.bindings,
					actions: credential.settings.actions,
				};
			});
			await page.getByRole("button", { name: "On this device", exact: true }).click();
			await page.getByRole("button", { name: "Credentials", exact: true }).click();
			await browserExpect(
				panel.getByRole("heading", { name: "Choose your assistants" }),
			).toBeVisible();
			await browserExpect(panel.getByRole("checkbox", { name: /Codex/ })).toBeChecked();
			await panel.getByRole("button", { name: "Finish setup" }).click();
			expect(
				await page.evaluate(() => {
					const s = (window as any).credentialTest.credential.settings;
					return { clients: s.clients, bindings: s.bindings, actions: s.actions };
				}),
			).toEqual(permissions);
			await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
			await panel.getByRole("button", { name: "Disconnect Bitwarden", exact: true }).click();
			await browserExpect(
				panel.getByRole("button", { name: "Connect Bitwarden", exact: true }),
			).toBeVisible();
			expect(
				await page.evaluate(
					() => (window as any).credentialTest.credential.settings.bindings.length,
				),
			).toBe(101);
			expect(errors).toEqual([]);
		} finally {
			await browser.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
	30000,
);
