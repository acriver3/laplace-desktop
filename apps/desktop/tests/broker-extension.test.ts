import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";

it.skipIf(!existsSync(chromium.executablePath()))(
	"checks actual login forms without exposing values or replaying submissions",
	async () => {
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			const source = (
				await readFile(new URL("../browser-extension/broker.js", import.meta.url), "utf8")
			).split("export async function connectBroker")[0]!;
			await page.route("**/*", (route) =>
				route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
			);
			await page.goto("https://login-test.invalid");
			const run = (command: string, input: object = {}) =>
				page.evaluate(
					({ source, command, input }) => {
						return new Function(source + ";return loginStep(arguments[0],arguments[1])")(
							command,
							input,
						);
					},
					{ source, command, input },
				);
			const form = (fields: string) =>
				`<form onsubmit="event.preventDefault();document.body.dataset.submitted=String(Number(document.body.dataset.submitted||0)+1)">${fields}<button>Next</button></form>`;
			await page.setContent(form('<input autocomplete="username"><input type="password">'));
			const view = await run("inspect");
			const args = {
				revision: view.revision,
				expires: Date.now() + 20000,
				origin: view.origin,
				values: { username: "synthetic-user", password: "synthetic-secret" },
			};
			expect(view.fields).toEqual(["username", "password"]);
			expect(await run("advance", { ...args, expires: Date.now() - 1 })).toEqual({ done: false });
			expect(await page.locator("input[type=password]").inputValue()).toBe("");
			expect(await run("advance", args)).toEqual({ done: true });
			expect(await run("advance", args)).toEqual({ done: false });
			expect(await page.locator("body").getAttribute("data-submitted")).toBe("1");
			expect(JSON.stringify(await run("inspect"))).not.toContain("synthetic");
			await page.setContent(form('<input autocomplete="username">'));
			const username = await run("inspect");
			expect(username.fields).toEqual(["username"]);
			expect(await run("advance", { ...args, revision: username.revision })).toEqual({
				done: true,
			});
			await page.setContent(form('<input type="password">'));
			const password = await run("inspect");
			expect(await run("advance", { ...args, revision: username.revision })).toEqual({
				done: false,
			});
			expect(await run("advance", { ...args, revision: password.revision })).toEqual({
				done: true,
			});
			for (const body of [
				form('<input autocomplete="one-time-code">'),
				form('<input type="password"><iframe></iframe>'),
				form("Approve OAuth access"),
				'<form action="https://elsewhere.invalid"><input type="password"><button>Next</button></form>',
			]) {
				await page.setContent(body);
				expect((await run("inspect")).handoff).toBe(true);
			}
			await page.setContent(
				form(
					'<input autocomplete="username" oninput="this.form.action=\'https://elsewhere.invalid\'"><input type="password">',
				),
			);
			const changed = await run("inspect");
			expect(await run("advance", { ...args, revision: changed.revision })).toEqual({
				done: false,
			});
			expect(await page.locator("input[type=password]").inputValue()).toBe("");
			// A page mutation while SHA-256 yields must be caught before the first field is filled.
			await page.setContent(form('<input type="password">'));
			const race = await run("inspect");
			await page.evaluate(() => {
				const digest = crypto.subtle.digest.bind(crypto.subtle);
				crypto.subtle.digest = async (...args) => {
					const value = await digest(...args);
					document.querySelector("form")!.action = "https://elsewhere.invalid";
					return value;
				};
			});
			expect(await run("advance", { ...args, revision: race.revision })).toEqual({ done: false });
			expect(await page.locator("input[type=password]").inputValue()).toBe("");
		} finally {
			await browser.close();
		}
	},
	30000,
);
