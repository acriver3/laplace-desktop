import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";
import { browserTargets, fillBrowser } from "@repo/local-runtime/credentials-cdp";
import { expect, it } from "vitest";

it.skipIf(!existsSync(chromium.executablePath()))(
	"fills synthetic credentials in an isolated real Chromium profile through CDP",
	async () => {
		const profile = await mkdtemp(join(tmpdir(), "laplace-cdp-test-"));
		const context = await chromium.launchPersistentContext(profile, {
			headless: true,
			args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
		});
		try {
			await context.route("**/*", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: '<form action="/login"><input autocomplete="username"><input type="password"><input autocomplete="one-time-code"></form>',
				}),
			);
			const page = await context.newPage();
			await page.goto("https://credential-test.invalid/login");
			const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
			const endpoint = `http://127.0.0.1:${port}`;
			const signal = AbortSignal.timeout(10000);
			const target = (await browserTargets(endpoint, signal)).find(
				(t) => t.origin === "https://credential-test.invalid",
			)!;
			expect(target).toBeDefined();
			const result = await fillBrowser(
				endpoint,
				target.id,
				[target.origin],
				{ username: "synthetic-user", password: "synthetic-password", totp: "123456" },
				signal,
			);
			expect(result).toEqual({ filledFields: 3, origin: "https://credential-test.invalid" });
			expect(await page.locator('input[type="password"]').inputValue()).toBe("synthetic-password");
			await page.locator('input[type="password"]').fill("");
			await page
				.locator("form")
				.evaluate((el) => el.setAttribute("action", "https://other.invalid/login"));
			await expect(
				fillBrowser(
					endpoint,
					target.id,
					[target.origin],
					{ password: "synthetic-password" },
					signal,
				),
			).rejects.toThrow();
			expect(await page.locator('input[type="password"]').inputValue()).toBe("");
		} finally {
			await context.close();
			await rm(profile, { recursive: true, force: true });
		}
	},
	30000,
);
