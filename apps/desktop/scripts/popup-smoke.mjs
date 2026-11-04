import assert from "node:assert/strict";

import { syntheticAccount, syntheticSessionCookie, setSyntheticSession } from "./feature-smoke.mjs";
import { syntheticWebPage } from "./web-shell-smoke.mjs";

/** Exercise the hosted web-view policy using intercepted HTTPS and a browser stub. */
export async function checkProviderPopup(app, invoke, until, setAuthenticated) {
	const provider = "https://provider.fixture.invalid/authorize?client=desktop-smoke";
	await app.evaluate(
		async ({ session, shell, dialog, clipboard }, { account, cookieName, html }) => {
			globalThis.__laplaceSmokeExternal = [];
			globalThis.__laplaceSmokeCopies = [];
			globalThis.__laplaceSmokeClipboardWrite = clipboard.writeText;
			clipboard.writeText = (text) => {
				globalThis.__laplaceSmokeCopies.push(text);
			};
			globalThis.__laplaceSmokeUnexpectedHttps = [];
			globalThis.__laplaceSmokeHostedLocalRequests = 0;
			globalThis.__laplaceSmokeDialog = dialog.showMessageBox;
			const openExternal = async (url) => {
				globalThis.__laplaceSmokeExternal.push(url);
			};
			shell.openExternal = openExternal;
			if (shell.openExternal !== openExternal)
				throw new Error("Unable to stub external browser opening");
			dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
			// Every HTTPS request in this temporary hosted partition is answered here.
			// Even a navigation-policy regression cannot reach a real provider/backend.
			const hostedSession = session.fromPartition("persist:laplace-hosted");
			await hostedSession.protocol.handle("https", async (request) => {
				const url = new URL(request.url);
				if (url.pathname.startsWith("/desktop/local"))
					globalThis.__laplaceSmokeHostedLocalRequests++;
				if (url.origin !== "https://connect.withlaplace.com") {
					globalThis.__laplaceSmokeUnexpectedHttps.push(url.href);
					return new Response("Unexpected synthetic navigation", { status: 400 });
				}
				if (url.pathname === "/api/desktop/capabilities")
					return Response.json({
						version: 1,
						browserSignIn: false,
						localMcpLinking: false,
						embeddedShellVersion: 1,
						webShellVersion: 1,
					});
				if (url.pathname === "/api/desktop/accounts") {
					// Protocol interception precedes browser-managed Cookie headers.
					// Read only this fixture cookie from the isolated hosted session.
					const cookies = await hostedSession.cookies.get({ url: url.href, name: cookieName });
					return cookies.some((cookie) => cookie.value === "synthetic-session")
						? Response.json(account)
						: Response.json({ error: "Sign in required" }, { status: 401 });
				}
				return new Response(html.replace("SHELL_HEADER", "0"), {
					headers: { "Content-Type": "text/html" },
				});
			});
		},
		{ account: syntheticAccount, cookieName: syntheticSessionCookie, html: syntheticWebPage },
	);
	try {
		await invoke("shell.profile", { profile: "hosted" });
		const hosted = await invoke("shell.status");
		assert.equal(hosted.profile, "hosted");
		await assert.rejects(invoke("shell.web"), /sign in/i);
		setAuthenticated(true);
		await setSyntheticSession(app, "hosted", hosted.origin);
		await invoke("shell.accounts");
		await invoke("shell.web");
		await until(
			async () =>
				app.evaluate(
					({ webContents }, origin) =>
						webContents
							.getAllWebContents()
							.some((contents) => contents.getURL().startsWith(`${origin}/`)),
					hosted.origin,
				),
			"Authenticated provider fixture did not load",
		);
		const parentId = await app.evaluate(
			({ webContents }, origin) =>
				webContents
					.getAllWebContents()
					.find((contents) => contents.getURL().startsWith(`${origin}/`))?.id,
			hosted.origin,
		);
		assert.ok(parentId, "Synthetic hosted web view was not created");
		// Exercise the same open-then-copy sequence as Connect's Send to agent button.
		const handoff = "codex://threads/new?prompt=Desktop%20handoff%20fixture";
		await app.evaluate(
			async ({ webContents }, { id, handoff }) => {
				await webContents.fromId(id).executeJavaScript(
					`(async () => {
				window.open(${JSON.stringify(handoff)}, "_blank", "noopener,noreferrer");
				await navigator.clipboard.writeText("Laplace handoff fixture").catch((error) => { throw new Error(error.name + ": " + error.message); });
			})()`,
					true,
				);
			},
			{ id: parentId, handoff },
		);
		await until(
			async () => app.evaluate(() => globalThis.__laplaceSmokeExternal.length === 1),
			"Agent handoff did not reach the native launcher",
		);
		assert.deepEqual(await app.evaluate(() => globalThis.__laplaceSmokeExternal), [handoff]);
		assert.equal(
			await app.evaluate(() => globalThis.__laplaceSmokeCopies.includes("Laplace handoff fixture")),
			true,
			"Clipboard write did not retain the fixture text",
		);
		assert.equal(
			await app.evaluate(
				async ({ webContents }, id) =>
					webContents
						.fromId(id)
						.executeJavaScript(
							"navigator.clipboard.readText().then(() => false, () => true)",
							true,
						),
				parentId,
			),
			true,
			"Connect must not receive clipboard read access",
		);
		assert.equal(
			await app.evaluate(
				async ({ webContents }, id) =>
					webContents
						.fromId(id)
						.executeJavaScript(
							"window.laplaceClipboard.writeText({text: 'invalid'}).then(() => false, () => true)",
							true,
						),
				parentId,
			),
			true,
			"Clipboard bridge must validate its payload",
		);
		await app.evaluate(() => {
			globalThis.__laplaceSmokeExternal = [];
		});
		const opened = await app.evaluate(
			async ({ webContents }, id) =>
				webContents
					.fromId(id)
					.executeJavaScript(
						'globalThis.__laplaceSmokePopup = window.open("about:blank", "laplace-provider-smoke"); Boolean(globalThis.__laplaceSmokePopup)',
						true,
					),
			parentId,
		);
		assert.equal(opened, true, "Hosted app could not create its initial blank OAuth popup");
		let childId;
		await until(async () => {
			childId = await app.evaluate(
				({ BrowserWindow }) =>
					BrowserWindow.getAllWindows().find(
						(window) => window.webContents.getURL() === "about:blank",
					)?.id,
			);
			return Boolean(childId);
		}, "Blank OAuth popup did not appear");
		const child = await app.evaluate(async ({ BrowserWindow }, id) => {
			const window = BrowserWindow.fromId(id),
				preferences = window.webContents.getLastWebPreferences();
			return {
				visible: window.isVisible(),
				sandbox: preferences.sandbox,
				node: preferences.nodeIntegration,
				isolated: preferences.contextIsolation,
				preload: preferences.preload,
				bridge: await window.webContents.executeJavaScript("typeof window.laplaceDesktop"),
			};
		}, childId);
		assert.equal(child.visible, false);
		assert.equal(child.sandbox, true);
		assert.equal(child.node, false);
		assert.equal(child.isolated, true);
		assert.ok(!child.preload);
		assert.equal(child.bridge, "undefined");
		// Match Connect's asynchronous about:blank -> provider location assignment.
		await app.evaluate(
			async ({ webContents }, { id, provider }) =>
				webContents
					.fromId(id)
					.executeJavaScript(
						`setTimeout(() => { globalThis.__laplaceSmokePopup.location.href = ${JSON.stringify(provider)}; }, 0); true`,
						true,
					),
			{ id: parentId, provider },
		);
		await until(
			async () => app.evaluate(({ BrowserWindow }, id) => !BrowserWindow.fromId(id), childId),
			"External OAuth popup was not cleaned up",
		);
		assert.deepEqual(
			await app.evaluate(() => globalThis.__laplaceSmokeExternal),
			[provider],
			"Provider URL was not handed off exactly once",
		);
		assert.deepEqual(
			await app.evaluate(() => globalThis.__laplaceSmokeUnexpectedHttps),
			[],
			"Provider navigation attempted to load inside Electron",
		);
		assert.equal(
			await app.evaluate(
				async ({ webContents }, id) =>
					webContents.fromId(id).executeJavaScript("typeof window.laplaceDesktop"),
				parentId,
			),
			"undefined",
		);
		await app.evaluate(
			async ({ webContents }, id) =>
				webContents
					.fromId(id)
					.executeJavaScript("document.getElementById('desktop-local').click(); true"),
			parentId,
		);
		await until(
			async () => (await invoke("shell.status")).mode === "local",
			"Hosted sidebar did not return to the device manager",
		);
		assert.equal((await invoke("shell.status")).profile, "hosted");
		assert.ok((await invoke("shell.status")).account);
		assert.equal(await app.evaluate(() => globalThis.__laplaceSmokeHostedLocalRequests), 0);
		await invoke("shell.profile", { profile: "local" });
		assert.equal((await invoke("shell.status")).profile, "local");
	} finally {
		setAuthenticated(false);
		await app.evaluate(({ dialog, clipboard }) => {
			dialog.showMessageBox = globalThis.__laplaceSmokeDialog;
			clipboard.writeText = globalThis.__laplaceSmokeClipboardWrite;
		});
		// Keep openExternal stubbed until this isolated app exits.
	}
}
