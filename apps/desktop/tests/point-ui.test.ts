import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, extname, sep } from "node:path";

import { chromium, expect as browserExpect } from "@playwright/test";
import sharp from "sharp";
import { expect, it } from "vitest";

import { PointCaptures } from "../src/point/captures";
import { PointServer } from "../src/point/server";

it.skipIf(!existsSync(chromium.executablePath()))(
	"opens native annotation requests only from an actual click and keeps the entire snip visible",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "point-page-"));
		const captures = new PointCaptures(root);
		await captures.initialize();
		const image = await sharp({
			create: { width: 1200, height: 800, channels: 3, background: "#457b9d" },
		})
			.png()
			.toBuffer();
		const item = await captures.save(image, { width: 1200, height: 800 });
		const server = new PointServer(captures);
		await server.start();
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
			await page.addInitScript(() => {
				Object.assign(document, {
					oai: {
						annotation: {
							request(target: HTMLElement, options: unknown) {
								Object.assign(window, {
									requestObservation: {
										target: target.id,
										options,
										active: navigator.userActivation.isActive,
									},
								});
								return { accepted: true };
							},
						},
					},
				});
			});
			await page.goto(server.url(item));
			await browserExpect(page.getByRole("button", { name: "Annotate this snip" })).toBeEnabled();
			expect(await page.evaluate(() => (window as any).requestObservation)).toBeUndefined();
			const box = await page.locator("#snip").boundingBox();
			expect(box!.y + box!.height).toBeLessThanOrEqual(600);
			expect(box!.x + box!.width).toBeLessThanOrEqual(800);
			await page.getByRole("button", { name: "Annotate this snip" }).click();
			expect(await page.evaluate(() => (window as any).requestObservation)).toMatchObject({
				target: "snip",
				active: true,
				options: {
					mode: "default",
					metadata: { source: "desktop-screenshot", width: 1200, height: 800 },
				},
			});
			await browserExpect(page.getByRole("status")).toContainText(
				"Ctrl+Enter adds it to the draft",
			);
			await page.waitForTimeout(50);
			expect(server.state(item)).toBe("requested");
			await mkdir(".cache", { recursive: true });
			await page.screenshot({ path: ".cache/point-snip-page.png" });
			const unsupported = await browser.newPage();
			await unsupported.goto(server.url(item));
			await browserExpect(
				unsupported.getByRole("button", { name: "Annotate this snip" }),
			).toBeDisabled();
			await browserExpect(unsupported.getByRole("status")).toContainText(
				"Native annotations are unavailable",
			);
		} finally {
			await browser.close();
			await server.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
);

it.skipIf(
	!existsSync(resolve("dist/renderer/point.html")) || !existsSync(chromium.executablePath()),
)("selects and cancels frozen snips without sharing the Desktop bridge", async () => {
	const directory = resolve("dist/renderer");
	const image = await sharp({
		create: { width: 1000, height: 700, channels: 3, background: "#e8edf4" },
	})
		.png()
		.toBuffer();
	const server = createServer(async (req, res) => {
		const path = resolve(
			directory,
			"." + new URL(req.url ?? "/point.html", "http://localhost").pathname,
		);
		if (!path.startsWith(directory + sep)) {
			res.writeHead(404).end();
			return;
		}
		try {
			res.setHeader(
				"Content-Type",
				(
					{ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<
						string,
						string
					>
				)[extname(path)] ?? "application/octet-stream",
			);
			res.end(await readFile(path));
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.addInitScript(
			(image) => {
				Object.assign(window, {
					pointTest: { selections: [], cancelled: false },
					laplacePoint: {
						async initialize() {
							return { image, destination: "Synthetic Codex chat" };
						},
						async select(rect: unknown) {
							(window as any).pointTest.selections.push(rect);
						},
						async cancel() {
							(window as any).pointTest.cancelled = true;
						},
					},
				});
			},
			`data:image/png;base64,${image.toString("base64")}`,
		);
		await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/point.html`);
		await browserExpect(page.getByText("Synthetic Codex chat")).toBeVisible();
		await page.mouse.move(160, 180);
		await page.mouse.down();
		await page.mouse.move(710, 490);
		await mkdir(".cache", { recursive: true });
		await page.screenshot({ path: ".cache/point-selection.png" });
		await page.mouse.up();
		expect(await page.evaluate(() => (window as any).pointTest.selections)).toEqual([
			{ x: 160, y: 180, width: 550, height: 310 },
		]);
		expect(await page.evaluate(() => typeof (window as any).laplaceDesktop)).toBe("undefined");
		await page.keyboard.press("Escape");
		expect(await page.evaluate(() => (window as any).pointTest.cancelled)).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
