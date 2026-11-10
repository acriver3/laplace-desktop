import assert from "node:assert/strict";
import { trayLabels } from "./tray-smoke.mjs";

// Exercise the packaged settings and registration without changing a real Codex draft.
export async function checkPoint(page, app, invoke) {
	const initial = await invoke("shell.point.status");
	assert.ok(!(await trayLabels(app)).includes("Capture with Point"));
	assert.equal(initial.available, true, "Packaged Point native adapter is missing");
	assert.deepEqual(initial.settings, {
		enabled: false,
		shortcut: "Control+L",
		destination: "codex-desktop",
	});
	await page
		.getByRole("navigation", { name: "On this device" })
		.getByRole("button", { name: "Tools", exact: true })
		.click();
	await page.getByRole("checkbox", { name: "Enable Laplace Point" }).waitFor();
	await page.getByLabel("Default agent", { exact: true }).selectOption("claude-browser");
	assert.equal((await invoke("shell.point.status")).settings.destination, "claude-browser");
	await page.getByLabel("Default agent", { exact: true }).selectOption("codex-desktop");
	assert.equal((await invoke("shell.point.status")).settings.destination, "codex-desktop");
	const shortcut = "Control+Alt+Shift+9";
	const reserved = await app.evaluate(
		({ globalShortcut }, shortcut) => globalShortcut.register(shortcut, () => {}),
		shortcut,
	);
	assert.equal(reserved, true, "Point smoke shortcut is already in use");
	try {
		const conflict = await invoke("shell.point.configure", { enabled: true, shortcut });
		assert.equal(conflict.registered, false);
		assert.ok((await trayLabels(app)).includes("Capture with Point"));
		assert.match(conflict.message, /unavailable/);
	} finally {
		await app.evaluate(
			({ globalShortcut }, shortcut) => globalShortcut.unregister(shortcut),
			shortcut,
		);
	}
	const enabled = await invoke("shell.point.configure", { enabled: true, shortcut });
	assert.equal(enabled.registered, true);
	// Use the real packaged protocol, preload, desktop capture and isolated session.
	// Cancel without cropping, so no screen content is written to disk or sent to Codex.
	await invoke("shell.point.capture");
	let overlays = [];
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		overlays = app
			.windows()
			.filter((window) => window.url() === "laplace-desktop://app/point.html");
		if (overlays.length) break;
		const state = await invoke("shell.point.status");
		if (state.phase === "needs-attention") {
			if (state.permissions.screen !== "granted") {
				assert.match(state.message, /Screen capture|Screen Recording/);
				assert.equal(state.capture, undefined);
				console.log(
					"Point smoke: screen recording unavailable for test app; verified permission failure and settings. Live overlay acceptance requires an OS grant.",
				);
				await invoke("shell.point.configure", initial.settings);
				await page
					.getByRole("navigation", { name: "On this device" })
					.getByRole("button", { name: "Connections", exact: true })
					.click();
				return;
			}
			throw new Error(state.message);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(overlays.length, "Point selection overlay did not open");
	for (const overlay of overlays) {
		await overlay.getByRole("main", { name: "Select a screenshot region" }).waitFor();
		await overlay.waitForFunction(() => document.querySelector(".point-screen")?.naturalWidth > 0);
		assert.equal(await overlay.evaluate(() => typeof window.laplaceDesktop), "undefined");
	}
	assert.equal((await invoke("shell.point.status")).phase, "capturing");
	assert.equal(overlays[0].isClosed(), false);
	await overlays[0].keyboard.press("Escape").catch((error) => {
		// Escape destroys the renderer on keydown; Playwright may fail to send keyup.
		if (
			!overlays[0].isClosed() ||
			!/Target page, context or browser has been closed/.test(error.message)
		)
			throw error;
	});
	assert.equal((await invoke("shell.point.status")).phase, "idle");
	assert.equal((await invoke("shell.point.status")).capture, undefined);
	assert.ok(overlays.every((overlay) => overlay.isClosed()));
	const disabled = await invoke("shell.point.configure", initial.settings);
	assert.ok(!(await trayLabels(app)).includes("Capture with Point"));
	assert.equal(disabled.registered, false);
	await invoke("shell.point.clear");
	assert.equal((await invoke("shell.point.status")).capture, undefined);
	await page
		.getByRole("navigation", { name: "On this device" })
		.getByRole("button", { name: "Connections", exact: true })
		.click();
}
