import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { BrokerChrome } from "@repo/local-runtime/broker-chrome";

it.skipIf(!existsSync(chromium.executablePath()))(
	"uses a real extension handoff tab and ephemeral relay while preserving unrelated tabs",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "laplace-extension-test-"));
		const extension = join(root, "extension");
		await cp(fileURLToPath(new URL("../browser-extension", import.meta.url)), extension, {
			recursive: true,
		});
		const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
		// Synthetic fixture only: production permissions remain requested by the user.
		manifest.host_permissions.push("https://login-test.invalid/*");
		await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
		const context = await chromium.launchPersistentContext(join(root, "profile"), {
			headless: true,
			channel: "chromium",
			args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
		});
		let login: any;
		const broker = new BrokerChrome(async (url) => {
			login = await context.newPage();
			await login.goto(url);
		});
		try {
			await context.route("https://login-test.invalid/**", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: '<form onsubmit="event.preventDefault();document.body.dataset.submitted=1"><input type="password"><button>Sign in</button></form>',
				}),
			);
			const unrelated = await context.newPage();
			await unrelated.goto("about:blank#keep");
			const signal = AbortSignal.timeout(20000);
			const id = await broker.open(
				"https://login-test.invalid/",
				["https://login-test.invalid"],
				signal,
			);
			await login.waitForURL("https://login-test.invalid/", { timeout: 10000 }).catch(async () => {
				throw Error(await login.locator("#status").textContent());
			});
			const view = await broker.inspect(id, signal);
			expect(view.fields).toEqual(["password"]);
			await broker.advance(id, view.revision, { password: "synthetic-canary" }, signal);
			expect(await login.locator("body").getAttribute("data-submitted")).toBe("1");
			expect(JSON.stringify(await broker.inspect(id, signal))).not.toContain("synthetic-canary");
			expect(unrelated.url()).toBe("about:blank#keep");
			broker.cancel(id);
		} finally {
			broker.shutdown();
			await context.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	30000,
);
