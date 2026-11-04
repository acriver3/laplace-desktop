import assert from "node:assert/strict";

import { checkWebShell } from "./web-shell-smoke.mjs";

export const syntheticSessionCookie = "laplace-desktop-smoke-session";
export const syntheticAccount = {
	user: { id: "desktop-smoke-user", name: "Desktop smoke user" },
	accounts: [{ id: "desktop-smoke-account", name: "Smoke account" }],
};

export async function setSyntheticSession(app, profile, origin) {
	await app.evaluate(
		async ({ session }, { profile, origin, name }) => {
			await session.fromPartition(`persist:laplace-${profile}`).cookies.set({
				url: origin,
				name,
				value: "synthetic-session",
				httpOnly: true,
				sameSite: "lax",
			});
		},
		{ profile, origin, name: syntheticSessionCookie },
	);
}

/** Unknown connector/client IDs ensure a gating regression cannot contact a provider. */
export async function checkSignedOutAccess(invoke) {
	/** @type {Array<[string, Record<string, unknown>]>} */
	const denied = [
		["hosted.connect", { clientId: "00000000-0000-4000-8000-000000000001" }],
		["shell.web", undefined],
	];
	for (const [method, input] of denied)
		await assert.rejects(invoke(method, input), /sign in/i, `${method} did not require login`);
	// Invalid install inputs and unknown connector IDs reach the helper signed out without a job.
	/** @type {Array<[string, Record<string, unknown>]>} */
	const local = [
		["catalog.install", { catalogId: "", configuration: {} }],
		["catalog.authenticate", { id: "smoke-no-catalog" }],
		["catalog.verify", { id: "smoke-no-catalog" }],
	];
	for (const [method, input] of local)
		await assert.rejects(
			invoke(method, input),
			(error) => !/sign in/i.test(String(error)),
			`${method} still required login`,
		);
	assert.ok(
		(await invoke("catalog.list")).length >= 4,
		"The catalog should remain browsable while signed out",
	);
	assert.equal((await invoke("status")).jobs.length, 0, "A denied operation started a catalog job");
}

export async function checkWebIsolation(app, origin) {
	const views = await app.evaluate(
		({ webContents }, origin) =>
			webContents
				.getAllWebContents()
				.filter((contents) => contents.getURL().startsWith(`${origin}/`))
				.map((contents) => ({ preferences: contents.getLastWebPreferences(), id: contents.id })),
		origin,
	);
	assert.equal(views.length, 1);
	assert.equal(views[0].preferences.nodeIntegration, false);
	assert.equal(views[0].preferences.contextIsolation, true);
	assert.equal(views[0].preferences.sandbox, true);
	assert.ok(!views[0].preferences.preload);
	assert.equal(
		await app.evaluate(
			async ({ webContents }, id) =>
				webContents.fromId(id).executeJavaScript("typeof window.laplaceDesktop"),
			views[0].id,
		),
		"undefined",
	);
}

const webViews = (app, origin) =>
	app.evaluate(
		({ webContents }, origin) =>
			webContents
				.getAllWebContents()
				.filter((contents) => contents.getURL().startsWith(`${origin}/`))
				.map((contents) => contents.id),
		origin,
	);

export async function checkFeatureAccess(
	app,
	invoke,
	until,
	origin,
	setAuthenticated,
	holdSignOut,
	includeEmbeddedLogout = false,
	localRouteRequests,
) {
	setAuthenticated(true);
	await setSyntheticSession(app, "local", origin);
	await invoke("shell.accounts");
	let shell = await invoke("shell.status");
	assert.equal(shell.account.id, syntheticAccount.user.id);
	assert.equal(shell.mode, "local", "Refreshing accounts left the local pages without a request");
	await invoke("shell.web");
	await until(
		async () => (await webViews(app, origin)).length === 1,
		"Signed-in Desktop did not open Connect",
	);
	shell = await invoke("shell.status");
	assert.equal(shell.mode, "web");
	await checkWebIsolation(app, origin);
	await checkWebShell(app, invoke, until, origin, localRouteRequests);
	// An ended session lands on Connect's login page; Desktop returns to its local pages.
	setAuthenticated(false);
	const [viewId] = await webViews(app, origin);
	await invoke("shell.web");
	await app.evaluate(
		async ({ webContents }, { id, url }) => {
			try {
				await webContents.fromId(id).loadURL(url);
			} catch (error) {
				// Session expiry can close the view before loadURL resolves.
				if (webContents.fromId(id)) throw error;
			}
		},
		{
			id: viewId,
			url: `${origin}/login`,
		},
	);
	await until(
		async () => !(await invoke("shell.status")).account,
		"An ended web session did not sign Desktop out",
	);
	shell = await invoke("shell.status");
	assert.equal(shell.mode, "local");
	assert.deepEqual(await webViews(app, origin), [], "Signed-out Desktop kept account content");
	await checkSignedOutAccess(invoke);
	setAuthenticated(true);
	await invoke("shell.accounts");
	assert.equal((await invoke("shell.status")).account.id, syntheticAccount.user.id);
	const held = holdSignOut();
	let signOutError;
	const signOut = invoke("shell.signOut").catch((error) => {
		signOutError = error;
	});
	try {
		await until(() => {
			if (signOutError) throw signOutError;
			return held.requested();
		}, "Synthetic sign-out request did not arrive");
		/** @type {Array<[string, Record<string, unknown> | undefined]>} */
		const duringSignOut = [
			["hosted.connect", { clientId: "00000000-0000-4000-8000-000000000001" }],
			["shell.signIn", undefined],
		];
		for (const [method, input] of duringSignOut)
			await assert.rejects(
				invoke(method, input),
				/profile or sign-in changed/,
				`${method} escaped the logout transition`,
			);
		assert.equal((await invoke("status")).jobs.length, 0);
		assert.equal((await invoke("shell.status")).mode, "local");
	} finally {
		held.release();
		await signOut;
	}
	assert.equal(signOutError, undefined);
	setAuthenticated(false);
	assert.equal((await invoke("shell.status")).account, undefined);
	if (includeEmbeddedLogout)
		await checkEmbeddedLogout(app, invoke, until, origin, setAuthenticated, holdSignOut);
}

async function checkEmbeddedLogout(app, invoke, until, origin, setAuthenticated, holdSignOut) {
	setAuthenticated(true);
	await setSyntheticSession(app, "local", origin);
	await invoke("shell.accounts");
	await invoke("shell.web");
	await until(async () => (await webViews(app, origin)).length === 1, "Connect did not open");
	const [viewId] = await webViews(app, origin);
	const held = holdSignOut();
	try {
		await app.evaluate(
			async ({ webContents }, id) =>
				webContents
					.fromId(id)
					.executeJavaScript(
						"globalThis.__laplaceLogout = 'pending'; fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' }).then(response => { globalThis.__laplaceLogout = response.ok ? 'complete' : 'failed'; }, () => { globalThis.__laplaceLogout = 'failed'; }); true",
					),
			viewId,
		);
		await until(
			() => held.requested(),
			"Embedded sign-out POST did not reach the synthetic server",
		);
		await assert.rejects(invoke("shell.signIn"), /profile or sign-in changed/);
		assert.equal(
			await app.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), viewId),
			true,
			"Denied action destroyed the view before its logout POST completed",
		);
		assert.equal((await invoke("shell.status")).account, undefined);
		assert.equal((await invoke("shell.status")).mode, "local");
	} finally {
		held.release();
	}
	await until(
		async () => app.evaluate(({ webContents }, id) => !webContents.fromId(id), viewId),
		"Embedded logout did not discard account content after completing",
	);
	await until(
		async () =>
			app.evaluate(
				async ({ session }, { origin, name }) =>
					(await session.fromPartition("persist:laplace-local").cookies.get({ url: origin, name }))
						.length === 0,
				{ origin, name: syntheticSessionCookie },
			),
		"Embedded logout did not clear the local profile cookie",
	);
	await assert.rejects(invoke("shell.web"), /sign in/i);
	setAuthenticated(false);
	assert.equal((await invoke("shell.status")).account, undefined);
}
