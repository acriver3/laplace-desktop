import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname, sep } from "node:path";

import { chromium, expect as browserExpect } from "@playwright/test";
import { expect, it } from "vitest";

import { assistantSetupPrompt } from "../src/shared/assistant-setup";

// Run after a desktop build. No real helper, vault, keychain, or agent configurations are used.
it.skipIf(
	!existsSync(resolve("dist/renderer/index.html")) || !existsSync(chromium.executablePath()),
)(
	"guides assistant setup with reusable registrations, launch and clipboard fallbacks, and manual setup",
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

			const prompts = Object.fromEntries(
				(["codex", "claude-code", "claude-desktop", "other"] as const).map((target) => [
					target,
					assistantSetupPrompt(target, {
						command: "/synthetic/node",
						args: [
							"/synthetic/bridge.cjs",
							"--root",
							"/synthetic/profile",
							"--client-id",
							"00000000-0000-4000-8000-000000000001",
						],
					}),
				]),
			);
			await page.addInitScript(
				({ prompts }) => {
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
					const snapshot: any = {
						mode: "local-only",
						origin: shell.origin,
						servers: [],
						clients: [],
						localTools: [],
						jobs: [],
						runId: "synthetic",
						stayLocalOnly: true,
					};
					const test = {
						history: [] as { method: string; input: any }[],
						failInstructions: true,
						opened: false,
						clipboard: false,
						copied: "",
						snapshot,
					};
					Object.assign(window, { assistantTest: test });
					Object.defineProperty(navigator, "clipboard", {
						value: {
							writeText: async (text: string) => {
								if (!test.clipboard) throw new Error("Clipboard blocked");
								test.copied = text;
							},
						},
					});
					const listeners = new Set<(event: any) => void>();
					window.laplaceDesktop = {
						onEvent: (listener) => {
							listeners.add(listener);
							return () => listeners.delete(listener);
						},
						invoke: async (method: string, input?: any): Promise<any> => {
							test.history.push({ method, input });
							if (method === "shell.local") {
								shell.section = input.section;
								for (const listener of listeners)
									listener({ event: "shell", data: structuredClone(shell) });
								return structuredClone(shell);
							}
							if (method === "shell.status") return structuredClone(shell);
							if (method === "status") return structuredClone(snapshot);
							if (method === "portable.status" || method === "portable.devices") return [];
							if (method === "catalog.list") return [];
							if (method === "client.register") {
								const client = {
									id: `00000000-0000-4000-8000-${String(snapshot.clients.length + 1).padStart(12, "0")}`,
									name: input.name,
									enabled: true,
									createdAt: "2026-01-01",
									hosted: "disconnected",
								};
								snapshot.clients.push(client);
								return client;
							}
							if (method === "shell.assistantSetup") {
								if (test.failInstructions) {
									test.failInstructions = false;
									throw new Error("Synthetic preparation unavailable. Retry setup.");
								}
								return {
									prompt: prompts[input.target],
									opened: input.action === "open" && test.opened,
								};
							}
							return {};
						},
					};
				},
				{ prompts },
			);
			await page.goto(`http://127.0.0.1:${port}`);
			await page.getByRole("button", { name: "AI clients", exact: true }).click();
			await browserExpect(page.getByText("Configuration file", { exact: true })).not.toBeVisible();
			await page.getByRole("button", { name: "Send setup to Codex", exact: true }).click();
			await browserExpect(
				page.getByText("Synthetic preparation unavailable. Retry setup.", { exact: true }).first(),
			).toBeVisible();
			await page.getByRole("button", { name: "Send setup to Codex", exact: true }).click();
			await browserExpect(page.getByText(/Couldn’t open Codex/)).toBeVisible();
			await page.getByText("View setup instructions", { exact: true }).click();
			await browserExpect(page.getByRole("textbox", { name: "Setup instructions" })).toHaveValue(
				prompts.codex!,
			);
			expect(await page.evaluate(() => (window as any).assistantTest.snapshot.clients.length)).toBe(
				1,
			);
			await page.evaluate(() => {
				const test = (window as any).assistantTest;
				test.opened = true;
				test.clipboard = true;
			});
			await page.getByRole("button", { name: "Send setup to Codex", exact: true }).click();
			await browserExpect(page.getByText(/Opening Codex with a setup draft/)).toBeVisible();
			await page.getByRole("button", { name: "Copy setup instructions", exact: true }).click();
			expect(await page.evaluate(() => (window as any).assistantTest.copied)).toBe(prompts.codex);
			await page.getByRole("button", { name: "Claude Code", exact: true }).click();
			await browserExpect(
				page.getByRole("textbox", { name: "Setup instructions" }),
			).not.toBeVisible();
			await page.getByRole("button", { name: "Send setup to Claude Code", exact: true }).click();
			await browserExpect(page.getByText(/Opening Claude Code with a setup draft/)).toBeVisible();
			expect(await page.evaluate(() => (window as any).assistantTest.snapshot.clients.length)).toBe(
				2,
			);
			await page.getByRole("button", { name: "Claude Desktop", exact: true }).click();
			await browserExpect(page.getByText(/If Claude cannot edit local files/)).toBeVisible();
			await page.getByRole("button", { name: "Send setup to Claude Desktop", exact: true }).click();
			await browserExpect(
				page.getByText(/Opening Claude Desktop with a setup draft/),
			).toBeVisible();
			await page.getByText("Advanced: manual setup", { exact: true }).click();
			await page.getByRole("button", { name: "Configure manually", exact: true }).click();
			await browserExpect(page.getByText("Configuration file", { exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Cancel", exact: true }).click();
			await page.getByRole("button", { name: "Other", exact: true }).click();
			await browserExpect(page.getByRole("button", { name: /Send setup to/ })).toHaveCount(0);
			await page
				.getByRole("combobox", { name: "Connection to use" })
				.selectOption({ label: "Codex" });
			await page.evaluate(() => {
				(window as any).assistantTest.clipboard = false;
			});
			await page.getByRole("button", { name: "Copy setup instructions", exact: true }).click();
			await browserExpect(page.getByText(/Clipboard unavailable/)).toBeVisible();
			expect(await page.evaluate(() => (window as any).assistantTest.snapshot.clients.length)).toBe(
				3,
			);
			expect(
				await page.evaluate(
					() =>
						(window as any).assistantTest.history.filter(
							(h: any) => h.method === "client.install" || h.method.startsWith("credentials."),
						).length,
				),
			).toBe(0);
			await page.getByRole("button", { name: "Codex", exact: true }).click();
			await page.screenshot({ path: ".cache/assistant-guided-setup.png", fullPage: true });
			expect(errors).toEqual([]);
		} finally {
			await browser.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
	30000,
);
