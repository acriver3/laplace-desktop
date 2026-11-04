import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";
import { expect, it } from "vitest";

import { BrokerBrowser } from "../src/helper/broker-browser";
import { browserTargets } from "../src/helper/credentials-cdp";
it.skipIf(!existsSync(chromium.executablePath()))(
	"submits a real login without exposing values and pauses on MFA, consent and cross-origin forms",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "laplace-broker-browser-"));
		const context = await chromium.launchPersistentContext(root, {
			headless: true,
			args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
		});
		try {
			await context.route("**/*", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: '<form action="/login" onsubmit="event.preventDefault();document.body.dataset.submitted=1"><input autocomplete="username"><input type="password"><button>Sign in</button></form>',
				}),
			);
			const page = await context.newPage();
			await page.goto("https://login-test.invalid");
			const port = (await readFile(join(root, "DevToolsActivePort"), "utf8")).split("\n")[0];
			const endpoint = "http://127.0.0.1:" + port,
				signal = AbortSignal.timeout(15000);
			const target = (await browserTargets(endpoint, signal)).find(
				(t) => t.origin === "https://login-test.invalid",
			)!;
			const browser = new BrokerBrowser(() => endpoint);
			await page.evaluate(() => {
				const frame = document.createElement("iframe");
				frame.style.cssText = "width:0;height:0;border:0";
				document.body.append(frame);
			});
			const view = await browser.inspect(target.id, signal);
			expect(view.fields).toEqual(["username", "password"]);
			expect(view.handoff).toBe(false);
			await browser.advance(
				target.id,
				view.revision,
				{ username: "synthetic-user", password: "synthetic-canary" },
				signal,
			);
			expect(await page.locator("body").getAttribute("data-submitted")).toBe("1");
			expect(JSON.stringify(await browser.inspect(target.id, signal))).not.toContain("synthetic");
			await page.reload();
			await expect(
				browser.advance(
					target.id,
					view.revision,
					{ username: "synthetic-user", password: "synthetic-canary" },
					signal,
				),
			).rejects.toThrow();
			await page.setContent(
				'<form onsubmit="event.preventDefault();document.body.dataset.step=1"><input autocomplete="username"><button>Next</button></form>',
			);
			const usernameStep = await browser.inspect(target.id, signal);
			expect(usernameStep.fields).toEqual(["username"]);
			await browser.advance(
				target.id,
				usernameStep.revision,
				{ username: "synthetic-user", password: "synthetic-canary" },
				signal,
			);
			expect(await page.locator("body").getAttribute("data-step")).toBe("1");
			await page.setContent(
				'<form onsubmit="event.preventDefault();document.body.dataset.step=2"><input type="password"><button>Sign in</button></form>',
			);
			const passwordStep = await browser.inspect(target.id, signal);
			expect(passwordStep.fields).toEqual(["password"]);
			await browser.advance(
				target.id,
				passwordStep.revision,
				{ password: "synthetic-canary" },
				signal,
			);
			expect(await page.locator("body").getAttribute("data-step")).toBe("2");
			await page.setContent(
				'<iframe src="about:blank"></iframe><form><input type="password"><button>Sign in</button></form>',
			);
			expect((await browser.inspect(target.id, signal)).handoff).toBe(true);
			await page.setContent(
				'<form><input autocomplete="one-time-code"><button>Continue</button></form>',
			);
			expect((await browser.inspect(target.id, signal)).handoff).toBe(true);
			await page.setContent(
				"<form><p>Approve application access</p><button>Continue</button></form>",
			);
			expect((await browser.inspect(target.id, signal)).handoff).toBe(true);
			await page.setContent(
				'<form action="https://other.invalid"><input type="password"><button>Sign in</button></form>',
			);
			expect((await browser.inspect(target.id, signal)).handoff).toBe(true);
			await expect(
				browser.advance(target.id, view.revision, { password: "synthetic-canary" }, signal),
			).rejects.toThrow();
		} finally {
			await context.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	30000,
);
