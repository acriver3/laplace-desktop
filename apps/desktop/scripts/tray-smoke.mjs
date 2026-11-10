import assert from "node:assert/strict";

// Observe the real native menu in the isolated smoke app, without exposing a test IPC.
export async function observeTray(app, invoke) {
	await app.evaluate(({ Tray }) => {
		const original = Tray.prototype.setContextMenu;
		Tray.prototype.setContextMenu = function (menu) {
			globalThis.smokeTrayMenu = menu;
			return original.call(this, menu);
		};
	});
	await invoke("shell.point.configure", (await invoke("shell.point.status")).settings);
}

export const trayLabels = (app) =>
	app.evaluate(() => globalThis.smokeTrayMenu.items.map((item) => item.label).filter(Boolean));

export async function checkRuntimeTray(app, invoke, until) {
	const labels = await trayLabels(app);
	assert.ok(labels.includes("Restart Laplace Runtime"));
	assert.ok(labels.includes("Stop Laplace Runtime"));
	assert.ok(labels.includes("Open Laplace"));
	assert.ok(labels.includes("Close Laplace Desktop"));
	assert.ok(!labels.includes("On this device"));
	assert.ok(!labels.includes("Keep computer awake while sharing remotely"));
	const before = await invoke("status");
	const configuration = (snapshot) => ({
		servers: snapshot.servers.map(({ id, name, enabled, access, tools }) => ({
			id, name, enabled, access,
			tools: tools.filter((tool) => tool.localEnabled).map((tool) => tool.name).sort(),
		})),
		clients: snapshot.clients,
	});
	const click = (label, twice = false) => app.evaluate(({ }, { label, twice }) => {
		const item = globalThis.smokeTrayMenu.items.find((item) => item.label === label);
		if (!item?.enabled) throw new Error(`Tray action not ready: ${label}`);
		item.click();
		if (twice) item.click();
	}, { label, twice });
	const actionReady = (label) => app.evaluate(({ }, label) =>
		globalThis.smokeTrayMenu.items.some((item) => item.label === label && item.enabled), label);
	const ready = async (oldRunId) => {
		await until(async () => {
			try {
				const current = await invoke("status");
				return current.runId !== oldRunId && current.servers.every((server) => server.status === "online");
			} catch { return false; }
		}, "Tray restart did not reconnect the runtime and its connectors");
		assert.deepEqual(configuration(await invoke("status")), configuration(before));
		await until(() => actionReady("Stop Laplace Runtime"), "Tray did not show the running state");
	};
	await click("Restart Laplace Runtime", true);
	await ready(before.runId);
	const restarted = await invoke("status");
	await click("Stop Laplace Runtime");
	await until(() => actionReady("Start Laplace Runtime"), "Tray did not show the stopped state");
	await click("Restart Laplace Runtime");
	await ready(restarted.runId);
	console.log("PASS tray: conditional Point entry, simplified menu, and restart from running/stopped with connections preserved");
}
