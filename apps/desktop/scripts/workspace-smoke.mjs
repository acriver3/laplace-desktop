import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "@playwright/test";

export async function checkWorkspace(page, app, appRoot, packaged, catalog) {
	const nav = page.getByRole("navigation", { name: "On this device" });
	await expect(page.getByRole("heading", { name: "On this device", exact: true })).toBeVisible();
	await expect(nav.getByRole("button")).toHaveText([
		"Connections",
		"AI clients",
		"Device",
		"Updates",
	]);
	await expect(nav.getByRole("button", { name: "Connections", exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	const sidebar = page.getByRole("complementary", { name: "Main sidebar" });
	await expect(
		sidebar.getByRole("navigation", { name: "Connector navigation" }).getByRole("button"),
	).toHaveText(["On this device", "Credentials"]);
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Back to Laplace" })).toHaveCount(0);
	await mkdir(join(appRoot, ".cache"), { recursive: true });
	const screenshot = async (name) => {
		await page.getByRole("heading", { level: 1 }).hover();
		return page.screenshot({
			path: join(appRoot, `.cache/local-${name}${packaged ? "-packaged" : ""}.png`),
			animations: "disabled",
			timeout: 60_000,
		});
	};
	await expect(
		page.getByRole("button", { name: "Add custom connection", exact: true }),
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Import configuration", exact: true }),
	).toBeEnabled();
	await expect(
		page.getByRole("group", { name: "Show connections" }).getByRole("button"),
	).toHaveText(["All", "Connected", "Available"]);
	const available = page.getByRole("list", { name: "Available connections" });
	await expect(available.getByRole("listitem")).toHaveCount(
		catalog.filter((entry) => !entry.installed).length,
	);
	for (const entry of catalog.filter((entry) => !entry.installed)) {
		const row = available
			.getByRole("listitem")
			.filter({ has: page.getByText(entry.name, { exact: true }) });
		const action = row.getByRole("button", {
			name: entry.importOnly ? "Import" : `More setup options for ${entry.name}`,
			exact: true,
		});
		if (entry.available || entry.importOnly) await expect(action).toBeEnabled();
		else await expect(action).toBeDisabled();
	}
	// Exercise trusted native handoff without launching or messaging a real agent.
	const setupEntry = catalog.find((entry) => entry.available && !entry.installed);
	assert.ok(setupEntry);
	await app.evaluate(({ shell }) => {
		globalThis.catalogOriginalOpen = shell.openExternal;
		globalThis.catalogDestinations = [];
		shell.openExternal = async (url) => {
			globalThis.catalogDestinations.push(url);
		};
	});
	try {
		const setupRow = available
			.getByRole("listitem")
			.filter({ has: page.getByText(setupEntry.name, { exact: true }) });
		await setupRow
			.getByRole("button", { name: `More setup options for ${setupEntry.name}` })
			.click();
		await page.getByRole("menuitem", { name: "Set up with Codex", exact: true }).click();
		await expect(setupRow.getByRole("status")).toContainText("Review and send the draft");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		const destinations = await app.evaluate(() => globalThis.catalogDestinations);
		assert.equal(destinations.length, 1);
		const destination = new URL(destinations[0]);
		assert.equal(destination.protocol, "codex:");
		assert.ok(destination.searchParams.get("prompt").includes(setupEntry.id));
		const prompt = destination.searchParams.get("prompt");
		const prefix = `Please set up ${setupEntry.name} with Laplace using these instructions: `;
		assert.ok(prompt.startsWith(prefix));
		const setupUrl = new URL(prompt.slice(prefix.length));
		assert.equal(setupUrl.origin + setupUrl.pathname, setupEntry.setupUrl);
		assert.equal(setupUrl.searchParams.get("version"), setupEntry.version);
		assert.equal(setupUrl.searchParams.get("environment"), "Local development");
		const invalid = await page.evaluate(async () => {
			try {
				await window.laplaceDesktop.invoke("shell.catalogSetup", {
					catalogId: "not-in-catalog",
					target: "codex",
					action: "open",
				});
				return false;
			} catch {
				return true;
			}
		});
		assert.ok(invalid);
		assert.equal((await app.evaluate(() => globalThis.catalogDestinations)).length, 1);
	} finally {
		await app.evaluate(({ shell }) => {
			shell.openExternal = globalThis.catalogOriginalOpen;
			delete globalThis.catalogOriginalOpen;
			delete globalThis.catalogDestinations;
		});
	}
	for (const scale of [1, 1.25, 1.5, 2]) {
		await page.evaluate((scale) => {
			document.documentElement.style.zoom = String(scale);
		}, scale);
		const overflow = await page.locator(".desktop-connection").evaluateAll((cards) =>
			cards.some((card) => {
				const rect = card.getBoundingClientRect();
				return [...card.querySelectorAll("button, .connector-row-title")].some((node) => {
					const r = node.getBoundingClientRect();
					return r.width > 0 && (r.right > rect.right + 1 || r.bottom > rect.bottom + 1);
				});
			}),
		);
		assert.equal(overflow, false, `Connection actions overflow at ${scale} scale`);
	}
	await page.evaluate(() => {
		document.documentElement.style.zoom = "1";
	});
	await screenshot("connections");
	await nav.getByRole("button", { name: "AI clients", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Send setup to Codex", exact: true }),
	).toBeEnabled();
	await expect(page.getByRole("group", { name: "AI assistants" }).getByRole("button")).toHaveText([
		"Codex",
		"Claude Code",
		"Claude Desktop",
		"Other",
	]);
	await screenshot("clients");
	await nav.getByRole("button", { name: "Device", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveValue(
		"local",
	);
	await expect(
		page.getByRole("button", { name: "Sign in to link a workspace", exact: true }),
	).toBeVisible();
	await screenshot("device");
	await sidebar.getByRole("button", { name: "Credentials", exact: true }).click();
	await expect(sidebar.getByRole("button", { name: "Credentials", exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await app.evaluate(({ Menu }) => {
		const items = Menu.getApplicationMenu()?.items.find((entry) => entry.label === "File")?.submenu
			?.items;
		for (const label of ["Laplace", "On this device"])
			if (!items?.some((entry) => entry.label === label))
				throw new Error(`Native ${label} menu item is missing`);
		if (items?.some((entry) => ["Connections", "Build apps"].includes(entry.label)))
			throw new Error("Native menu still exposes removed Desktop pages");
	});
	await sidebar.getByRole("button", { name: "On this device", exact: true }).click();
}

export async function checkAnonymousConfiguration(page, app, invoke, appRoot, testRoot) {
	const sidebar = page.getByRole("complementary", { name: "Main sidebar" });
	await page
		.getByRole("navigation", { name: "On this device" })
		.getByRole("button", { name: "Connections", exact: true })
		.click();
	assert.equal((await invoke("shell.status")).section, "servers");
	const fixture = join(appRoot, "tests/fixtures/connector.mjs");
	const importFile = join(testRoot, "synthetic-import.json");
	await writeFile(
		importFile,
		JSON.stringify({
			mcpServers: { "smoke-import": { command: "node", args: [fixture], disabled: true } },
		}),
	);
	await app.evaluate(({ dialog }, file) => {
		globalThis.__laplaceSmokeOpenDialog = dialog.showOpenDialog;
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
	}, importFile);
	try {
		await page.getByRole("button", { name: "Import configuration", exact: true }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Import MCP configuration" })).toBeVisible();
		await dialog.getByRole("checkbox", { name: "smoke-import", exact: true }).check();
		await dialog.getByRole("button", { name: "Import 1", exact: true }).click();
		await expect(dialog).not.toBeVisible();
		const imported = (await invoke("status")).servers.find(
			(server) => server.id === "smoke-import",
		);
		assert.equal(imported.enabled, false);
		assert.equal(imported.status, "stopped");
		await invoke("server.remove", { id: "smoke-import" });
	} finally {
		await app.evaluate(({ dialog }) => {
			dialog.showOpenDialog = globalThis.__laplaceSmokeOpenDialog;
		});
	}
	await page.getByRole("button", { name: "Add custom connection", exact: true }).click();
	const form = page.getByRole("dialog");
	await form.getByLabel("Name", { exact: true }).fill("Synthetic smoke connector");
	await form.getByLabel("Server ID", { exact: true }).fill("desktop-smoke");
	await form.getByLabel("Executable", { exact: true }).fill("node");
	await form.getByRole("textbox", { name: /Arguments/ }).fill(JSON.stringify([fixture]));
	await expect(
		form.getByRole("checkbox", { name: "Start the server after saving" }),
	).not.toBeChecked();
	await form.getByRole("button", { name: "Review configuration", exact: true }).click();
	await expect(form.getByText("Keep stopped", { exact: true })).toBeVisible();
	await form.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(form).not.toBeVisible();
	assert.equal((await invoke("shell.status")).account, undefined);
	assert.equal((await invoke("status")).servers[0].status, "stopped");
}

export async function checkLocalData(page, invoke) {
	const sidebar = page.getByRole("complementary", { name: "Main sidebar" });
	const nav = page.getByRole("navigation", { name: "On this device" });
	await nav.getByRole("button", { name: "Connections", exact: true }).click();
	const available = page.getByRole("list", { name: "Available connections" });
	const local = page.getByRole("list", { name: "Local connections" });
	const yc = available.getByText("Y Combinator", { exact: true });
	await expect(yc).toBeVisible();
	await invoke("catalog.install", { catalogId: "ycombinator-demo", configuration: {} });
	const ycOptions = local.getByRole("button", { name: /^Options for Y Combinator / });
	await expect(ycOptions).toBeVisible();
	await expect(yc).toHaveCount(0);
	await ycOptions.click();
	await page.getByRole("menuitem", { name: "Delete connection" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
	await expect(ycOptions).toHaveCount(0);
	await expect(yc).toBeVisible();
	await expect(
		page.getByText("Synthetic smoke connector", { exact: true }).filter({ visible: true }),
	).toBeVisible();
	await page.getByRole("searchbox", { name: "Search connections" }).fill("not-present");
	await expect(
		page
			.getByRole("region", { name: "This device", exact: true })
			.getByText("No matching connections.", { exact: true }),
	).toBeVisible();
	await page.getByRole("searchbox", { name: "Search connections" }).fill("");
	await page
		.getByRole("button", {
			name: "Details for Synthetic smoke connector",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("dialog").getByText("Local diagnostics", { exact: true }),
	).toBeVisible();
	await page.getByRole("dialog").getByRole("button", { name: "Close dialog", exact: true }).click();
	await nav.getByRole("button", { name: "AI clients", exact: true }).click();
	await page.getByRole("button", { name: "Claude Desktop", exact: true }).click();
	await page.getByText("Advanced: manual setup", { exact: true }).click();
	await page
		.getByLabel("Assistant name (optional)", { exact: true })
		.fill("Local workspace smoke client");
	await page.getByRole("button", { name: "Configure manually", exact: true }).click();
	await expect(page.getByRole("dialog").getByRole("combobox")).toHaveValue("claude-desktop");
	await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
	const client = (await invoke("status")).clients.find(
		(entry) => entry.name === "Local workspace smoke client",
	);
	assert.ok(client);
	await expect(page.locator("summary").filter({ hasText: client.name })).toBeVisible();
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page
		.getByRole("combobox", { name: "Connection to use", exact: true })
		.selectOption(client.id);
	await page.getByRole("button", { name: "Configure manually", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Show configuration", exact: true })
		.click();
	await expect(
		page.getByRole("dialog").getByRole("button", { name: "Install connection", exact: true }),
	).toHaveCount(0);
	await expect(page.getByRole("dialog").getByRole("textbox")).toHaveValue(/--client-id/);
	await page.getByRole("dialog").getByRole("button", { name: "Close dialog", exact: true }).click();
	await invoke("client.revoke", { clientId: client.id });
	await expect(page.locator("summary").filter({ hasText: client.name })).toContainText("Revoked");
	assert.equal((await invoke("shell.status")).account, undefined);
	await sidebar.getByRole("button", { name: "On this device", exact: true }).click();
}
