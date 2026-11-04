import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// A real link exercises Electron's navigation boundary without a privileged web preload.
export const syntheticWebPage =
	"<!doctype html><title>Synthetic Laplace workspace</title><meta name='desktop-shell' content='SHELL_HEADER'><main><h1>Synthetic workspace</h1><a id='desktop-local' href='/desktop/local'>Connections</a></main>";

export async function checkWebShell(app, invoke, until, origin, requests) {
	// Playwright clicks do not activate the macOS application like a real user click.
	await app.evaluate(({ app: application, BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0];
		if (window.isMinimized()) window.restore();
		window.show();
		application.focus({ steal: true });
		window.focus();
	});
	await until(
		async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
		"Synthetic Desktop window could not acquire native focus",
	);
	const viewId = await app.evaluate(
		({ webContents }, origin) =>
			webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(`${origin}/`))
				?.id,
		origin,
	);
	assert.ok(viewId, "Authenticated workspace was not loaded");
	const readLayout = () =>
		app.evaluate(({ BrowserWindow }, id) => {
			const window = BrowserWindow.getAllWindows()[0];
			const view = window.contentView.children.find((child) => child.webContents?.id === id);
			return {
				bounds: view?.getBounds(),
				visible: view?.getVisible(),
				size: window.getContentSize(),
			};
		}, viewId);
	const fillsWindow = async () => {
		const { bounds, visible, size } = await readLayout();
		return (
			!!visible &&
			bounds.x === 0 &&
			bounds.y === 0 &&
			bounds.width === size[0] &&
			bounds.height === size[1]
		);
	};
	await until(fillsWindow, "Connect did not fill the Desktop window");
	const page = await app.firstWindow();
	assert.equal(
		await app.evaluate(
			async ({ webContents }, id) =>
				webContents
					.fromId(id)
					.executeJavaScript("document.querySelector('meta[name=\"desktop-shell\"]').content"),
			viewId,
		),
		"0",
		"Desktop still asked Connect for chrome-less embedded pages",
	);
	const originalSize = await app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0];
		const size = window.getSize();
		const minimum = window.getMinimumSize();
		window.setSize(
			size[0] - 80 >= minimum[0] ? size[0] - 80 : size[0] + 80,
			size[1] - 60 >= minimum[1] ? size[1] - 60 : size[1] + 60,
		);
		return size;
	});
	try {
		await until(
			async () => (await readLayout()).size[0] !== originalSize[0] && (await fillsWindow()),
			"Window resize did not resize Connect",
		);
	} finally {
		await app.evaluate(
			({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
			originalSize,
		);
	}
	await until(fillsWindow, "Restored window size did not resize Connect");
	const originalUrl = `${origin}/fixture/apps?app=project&preview=1`;
	await app.evaluate(async ({ webContents }, { id, url }) => webContents.fromId(id).loadURL(url), {
		id: viewId,
		url: originalUrl,
	});
	const userAgent = await app.evaluate(
		({ webContents }, id) => webContents.fromId(id).getUserAgent(),
		viewId,
	);
	assert.match(userAgent, /LaplaceDesktop\/0\.1(?:\s|$)/);
	// Connect shows its On this device sidebar link only when the page itself sees this token.
	assert.match(
		await app.evaluate(
			async ({ webContents }, id) =>
				webContents.fromId(id).executeJavaScript("navigator.userAgent"),
			viewId,
		),
		/LaplaceDesktop\/0\.1(?:\s|$)/,
	);
	const click = (path) =>
		app.evaluate(
			async ({ webContents }, { id, path }) =>
				webContents
					.fromId(id)
					.executeJavaScript(
						`(() => { const link = document.getElementById('desktop-local'); link.href = ${JSON.stringify(path)}; link.click(); })(); true`,
					),
			{ id: viewId, path },
		);
	for (const path of ["/desktop/local?fixture=1", "/desktop/local/"]) {
		await click(path);
		await until(
			async () =>
				app.evaluate(
					({ webContents }, { id, url }) => {
						const contents = webContents.fromId(id);
						return contents.getURL() === url && !contents.isLoadingMainFrame();
					},
					{
						id: viewId,
						url: `${origin}${path}`,
					},
				),
			`Ordinary ${path} navigation did not finish`,
		);
		assert.equal(
			(await invoke("shell.status")).mode,
			"web",
			"A non-exact local URL entered the manager",
		);
	}
	// A fragment-only navigation must also stay within the hosted workspace.
	await click("/desktop/local#fixture");
	await until(
		async () =>
			app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id).getURL() === url, {
				id: viewId,
				url: `${origin}/desktop/local#fixture`,
			}),
		"Fragment navigation did not finish",
	);
	assert.equal((await invoke("shell.status")).mode, "web");
	await app.evaluate(async ({ webContents }, { id, url }) => webContents.fromId(id).loadURL(url), {
		id: viewId,
		url: originalUrl,
	});
	await app.evaluate(({ shell, dialog }) => {
		globalThis.__laplaceSidebarExternal = [];
		globalThis.__laplaceSidebarOpenExternal = shell.openExternal;
		globalThis.__laplaceSidebarDialog = dialog.showMessageBox;
		shell.openExternal = async (url) => {
			globalThis.__laplaceSidebarExternal.push(url);
		};
		dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
	});
	try {
		const external = "https://sidebar.fixture.invalid/desktop/local";
		await click(external);
		await until(
			async () => app.evaluate(() => globalThis.__laplaceSidebarExternal.length === 1),
			"Foreign-origin link did not use the external navigation boundary",
		);
		assert.deepEqual(await app.evaluate(() => globalThis.__laplaceSidebarExternal), [external]);
		assert.equal(
			(await invoke("shell.status")).mode,
			"web",
			"A foreign-origin URL entered the manager",
		);
	} finally {
		await app.evaluate(({ shell, dialog }) => {
			shell.openExternal = globalThis.__laplaceSidebarOpenExternal;
			dialog.showMessageBox = globalThis.__laplaceSidebarDialog;
		});
	}
	const before = requests();
	await click("/desktop/local");
	await until(
		async () => (await invoke("shell.status")).mode === "local",
		"The web sidebar's On this device link did not open the local pages",
	);
	await page.getByRole("heading", { name: "On this device", exact: true }).waitFor();
	await until(async () => !(await readLayout()).visible, "Connect still covered the local pages");
	assert.ok(
		(await invoke("shell.status")).account,
		"Opening the device manager signed the user out",
	);
	assert.equal(requests(), before, "The local sidebar action was sent to the backend");
	await until(
		async () =>
			(await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL())) ===
			"laplace-desktop://app/index.html",
		"Returning to the manager did not focus the trusted local renderer",
	);
	await page.getByRole("button", { name: "Back to Laplace" }).click();
	await until(fillsWindow, "Back to Laplace did not show Connect again");
	assert.equal(
		await app.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), viewId),
		originalUrl,
		"Back to Laplace did not reopen the same Connect page",
	);
	const menu = (label) =>
		app.evaluate(({ Menu }, label) => {
			const item = Menu.getApplicationMenu()
				?.items.find((entry) => entry.label === "File")
				?.submenu?.items.find((entry) => entry.label === label);
			if (!item) throw new Error(`Native ${label} menu item is missing`);
			item.click();
		}, label);
	await menu("On this device");
	await until(async () => (await invoke("shell.status")).mode === "local", "Menu did not go local");
	await menu("Laplace");
	await until(fillsWindow, "Menu did not reopen Connect");
	assert.equal(
		await app.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), viewId),
		originalUrl,
	);
	// Mount the actual Connect presentation hook in a synthetic workspace (no account access).
	const fixture = await build({
		jsx: "automatic",
		alias: { react: dirname(createRequire(import.meta.url).resolve("react")) },
		stdin: {
			loader: "tsx",
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			contents: `
			import React, { useRef, useState } from "react";
			import { createRoot } from "react-dom/client";
			import { useDesktopLocalContent } from "../connector/modules/useDesktopLocalContent";
			import { DesktopUpdateButton } from "../connector/modules/DesktopUpdateButton";
			function Fixture() {
				const ref = useRef(null);
				const [route, setRoute] = useState("/fixture/home");
				const [collapsed, collapse] = useState(false);
				const [menu, setMenu] = useState(false);
				const active = useDesktopLocalContent(ref, route, true);
				return <div style={{display: "grid", gridTemplateColumns: (collapsed ? "64px" : "240px") + " 1fr", height: "100vh"}}>
					<aside aria-label="Main sidebar">
						<DesktopUpdateButton />
						<a id="home" href="/fixture/home" onClick={e => { e.preventDefault(); setRoute("/fixture/home"); }}>Home</a>
						<a id="desktop-local" href="/desktop/local" aria-current={active ? "page" : undefined}>On this device</a>
						<button id="collapse" onClick={() => collapse(!collapsed)}>Collapse</button>
						<button id="account" onClick={() => setMenu(!menu)}>Workspace</button>
						{menu && <div role="menu"><button id="switch" onClick={() => {setRoute("/another/home");setMenu(false);}}>Switch workspace</button></div>}
					</aside>
					<main ref={ref}><div style={{visibility: active ? "hidden" : undefined}}>Hosted content</div></main>
				</div>;
			}
			document.body.style.margin = "0";
			document.body.innerHTML = '<div id="root"></div>';
			createRoot(document.getElementById("root")).render(<Fixture/>);
		`,
		},
		bundle: true,
		write: false,
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const run = (code, id = viewId) =>
		app.evaluate(
			async ({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code),
			{ id, code },
		);
	await run(fixture.outputFiles[0].text);
	await until(
		async () => run("!!document.querySelector('#home')"),
		"Persistent shell did not mount",
	);
	await until(
		async () =>
			app.evaluate(({ webContents }) =>
				webContents
					.getAllWebContents()
					.some((w) => w.getURL().includes("contentOnly=1") && !w.isLoadingMainFrame()),
			),
		"Native content view did not initialize",
	);
	await click("/desktop/local");
	await until(
		async () => (await invoke("shell.status")).localEmbedded,
		"Local content did not retain Connect shell",
	);
	assert.equal((await readLayout()).visible, true);
	const panelId = await app.evaluate(
		({ webContents }) =>
			webContents.getAllWebContents().find((w) => w.getURL().includes("contentOnly=1")).id,
	);
	const panelLayout = () =>
		app.evaluate(({ BrowserWindow }, id) => {
			const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
				(v) => v.webContents?.id === id,
			);
			return { visible: view.getVisible(), bounds: view.getBounds() };
		}, panelId);
	await until(
		async () => (await panelLayout()).visible && (await panelLayout()).bounds.x === 240,
		"Native content overlapped sidebar",
	);
	await until(
		async () =>
			run("document.querySelector('#desktop-local').getAttribute('aria-current') === 'page'"),
		"Local selection did not reach sidebar",
	);
	assert.equal(
		await run("!!document.querySelector('aside')", panelId),
		false,
		"Embedded content duplicated sidebar",
	);
	assert.equal(await run('!!document.querySelector("[title*=Update]")'), false);
	await app.evaluate(({ webContents }, id) => {
		const contents = webContents.fromId(id);
		globalThis.__updateTestSend = contents.send.bind(contents);
		contents.send = (channel, ...args) =>
			globalThis.__updateTestSend(
				channel,
				...(channel === "laplace:update-available" ? [true] : args),
			);
		contents.send("laplace:update-available", true);
	}, viewId);
	await until(
		async () => run('!!document.querySelector("[title*=Update]")'),
		"Update button did not appear",
	);
	await run('document.querySelector("[title*=Update]").click()');
	await until(
		async () => (await invoke("shell.status")).section === "updates",
		"Update button did not open native details",
	);
	assert.equal((await invoke("shell.status")).localEmbedded, true);
	await until(
		async () =>
			run(
				'Array.from(document.querySelectorAll("button")).some(b => b.textContent === "Not now")',
				panelId,
			),
		"Update choice missing",
	);
	await run(
		'Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Not now").click()',
		panelId,
	);
	await until(
		async () => (await invoke("shell.status")).mode === "web",
		"Not now did not return to workspace",
	);
	await app.evaluate(({ webContents }, id) => {
		const contents = webContents.fromId(id);
		contents.send = globalThis.__updateTestSend;
		delete globalThis.__updateTestSend;
		contents.send("laplace:update-available", false);
	}, viewId);
	await until(
		async () => run('!document.querySelector("[title*=Update]")'),
		"Update button remained after availability cleared",
	);
	await click("/desktop/local");
	for (const [label, section] of [
		["AI clients", "clients"],
		["Device", "device"],
		["Connections", "servers"],
	]) {
		await run(
			`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`,
			panelId,
		);
		await until(
			async () => (await invoke("shell.status")).section === section,
			`Local ${label} tab did not open`,
		);
		assert.equal((await invoke("shell.status")).localEmbedded, true);
	}
	await click("/desktop/credentials");
	await until(
		async () => (await invoke("shell.status")).section === "credentials",
		"Credentials sidebar did not open",
	);
	assert.equal((await invoke("shell.status")).localEmbedded, true);
	await click("/desktop/local");
	await run("document.querySelector('#collapse').click()");
	await until(
		async () => (await panelLayout()).bounds.x === 64,
		"Collapsed sidebar did not resize native content",
	);
	await app.evaluate(({ BrowserWindow }) => {
		const w = BrowserWindow.getAllWindows()[0];
		const [x, y] = w.getSize();
		w.setSize(x + 30, y + 30);
	});
	await until(
		async () => (await panelLayout()).bounds.width === (await readLayout()).size[0] - 64,
		"Resize left stale content bounds",
	);
	await run("document.querySelector('#account').click()");
	await until(async () => !(await panelLayout()).visible, "Native content covered workspace menu");
	await run("document.querySelector('#account').click()");
	await until(
		async () => (await panelLayout()).visible,
		"Native content failed to return after menu closed",
	);
	await run("document.querySelector('#home').click()");
	await until(
		async () =>
			!(await invoke("shell.status")).localEmbedded &&
			(await invoke("shell.status")).mode === "web",
		"Same-route sidebar navigation did not restore web content",
	);
	await menu("On this device");
	await until(
		async () => (await invoke("shell.status")).localEmbedded,
		"Native menu bypassed persistent sidebar",
	);
	await run("document.querySelector('#account').click()");
	await run("document.querySelector('#switch').click()");
	await until(
		async () => (await invoke("shell.status")).mode === "web",
		"Workspace switch did not restore hosted content",
	);
	await menu("On this device");
	await until(
		async () => (await invoke("shell.status")).localEmbedded,
		"Repeated local selection failed",
	);
	await menu("Laplace");
	await until(
		async () => !(await panelLayout()).visible && (await fillsWindow()),
		"Native menu did not restore web content",
	);
	// A web dialog/drawer must also render above native content.
	await menu("On this device");
	await run(
		"const dialog = document.createElement('div'); dialog.id = 'test-dialog'; dialog.setAttribute('role', 'dialog'); dialog.textContent = 'Navigation drawer'; document.body.appendChild(dialog);",
	);
	await until(
		async () => !(await panelLayout()).visible,
		"Native content covered a web dialog/drawer",
	);
	await run("document.querySelector('#test-dialog').remove()");
	await until(
		async () => (await panelLayout()).visible,
		"Dialog close did not restore native content",
	);
	await menu("Laplace");
	console.log(
		"PASS Electron persistent sidebar: real layout hook, local tabs, collapse/resize, menus/dialogs, workspace and same-route navigation",
	);
	// Route unmount can clear the old content slot before the hosted-navigation request.
	await menu("On this device");
	await run("window.laplaceShell.reportLayout(null).then(() => window.laplaceShell.showWeb())");
	assert.equal(
		(await invoke("shell.status")).mode,
		"web",
		"Slot unmount stranded navigation in fallback mode",
	);
	// Leave subsequent auth/fallback checks with the original synthetic page.
	await app.evaluate(async ({ webContents }, { id, url }) => webContents.fromId(id).loadURL(url), {
		id: viewId,
		url: originalUrl,
	});
}
