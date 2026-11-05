import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, isAbsolute, extname } from "node:path";

import {
	app,
	clipboard,
	BrowserWindow,
	WebContentsView,
	Menu,
	Tray,
	nativeImage,
	ipcMain,
	protocol,
	powerMonitor,
	session,
	shell,
	dialog,
	screen,
	type WebContents,
} from "electron";

import { assistantSetupDestination, assistantSetupPrompt } from "../shared/assistant-setup";
import { browserConnectionsEnabled } from "../shared/browser-feature";
import {
	catalogSetupDestination,
	catalogSetupPrompt,
	type SetupCatalogEntry,
} from "../shared/catalog-setup";
import { helperInputs, privateHelperMethods, type HelperMethod } from "../shared/helper-contracts";
import {
	profiles,
	shellRequest,
	type LocalSection,
	type Profile,
	type ShellState,
} from "../shared/shell-contracts";
import { acknowledgeUpdate } from "../update/installer";
import { SourceUpdater } from "../update/source";
import { registerBrowserNativeHost } from "./browser-native-host";
import {
	requireLaplaceSession,
	requiresLaplaceSignIn,
	requireStableAuthentication,
	restorePersistedAccount,
} from "./feature-access";
import { HelperClient } from "./helper-client";
import {
	agentHandoffUrl,
	connectClipboardWrite,
	desktopLocalNavigation,
	desktopUserAgentToken,
	externalUrl,
	permittedWebOrigin,
	restorableWebUrl,
	trustedRenderer,
	webSessionEnded,
} from "./navigation";
import { PointController } from "./point";
import { registerRendererProtocol } from "./renderer-protocol";
import { syncSetupNotifications } from "./setup-notifications";
import { beginBrowserSignIn, type BrowserSignIn } from "./sign-in";
import { handleSquirrelEvents } from "./squirrel";
import { webShellRequest } from "./web-shell";

protocol.registerSchemesAsPrivileged([
	{
		scheme: "laplace-desktop",
		privileges: { standard: true, secure: true, supportFetchAPI: true },
	},
]);
app.setName("Laplace");
if (process.env.LAPLACE_DESKTOP_TEST_ROOT)
	app.setPath("userData", process.env.LAPLACE_DESKTOP_TEST_ROOT);
const updateProbe = process.argv
	.find((value) => /^--laplace-update-probe=[0-9a-f-]{36}$/.test(value))
	?.split("=")[1];
const updateAcceptance = process.argv
	.find((value) => /^--laplace-update-accept=[0-9a-f-]{36}$/.test(value))
	?.split("=")[1];
let updater: SourceUpdater | undefined;
let point: PointController | undefined;
const installerInvocation = handleSquirrelEvents();
const profileArgument = process.argv
	.find((value) => value.startsWith("--laplace-profile="))
	?.split("=")[1];
const requestedProfile: Profile | undefined =
	profileArgument === "hosted" || profileArgument === "local" ? profileArgument : undefined;
const primaryInstance =
	!installerInvocation && app.requestSingleInstanceLock({ profile: requestedProfile });
if (!installerInvocation && !primaryInstance) app.quit();

const appRoot = resolve(__dirname, "..");
const resources = app.isPackaged
	? join(process.resourcesPath, "runtime")
	: resolve(appRoot, "../resources");
const devUrl = !app.isPackaged ? process.env.LAPLACE_DESKTOP_DEV_URL : undefined;
const uiUrl = devUrl ?? "laplace-desktop://app/index.html";
const testOrigin =
	!app.isPackaged &&
	process.env.LAPLACE_DESKTOP_TEST_ROOT &&
	process.env.LAPLACE_DESKTOP_TEST_ORIGIN &&
	/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.LAPLACE_DESKTOP_TEST_ORIGIN)
		? process.env.LAPLACE_DESKTOP_TEST_ORIGIN
		: undefined;
let window: BrowserWindow;
let web: WebContentsView | undefined;
let localPanel: WebContentsView | undefined;
let localPanelReady = false;
let localPanelLoading: Promise<void> | undefined;
let contentLayout:
	| { x: number; y: number; width: number; height: number; blocked: boolean }
	| undefined;
let tray: Tray;
let helper: HelperClient | undefined;
let signIn: BrowserSignIn | undefined;
let startingSignIn = false;
const popups = new Set<BrowserWindow>();
let quitting = false;
let changingProfile = false;
let signingOut = false;
const authenticationStable = () => !changingProfile && !signingOut && !quitting;
let webGeneration = 0;
let hostedReady = false;
let lastWebUrl: string | undefined;
let profileGeneration = 0;
let authController = new AbortController();
const pendingAuth = new Set<Promise<unknown>>();
function invalidateAuth() {
	profileGeneration++;
	authController.abort();
	authController = new AbortController();
	signIn?.cancel();
	signIn = undefined;
	state.signIn = "idle";
	return Promise.allSettled([...pendingAuth]);
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const initialState = (profile: Profile): ShellState => ({
	updates: updater?.state,
	profile,
	origin: testOrigin ?? profiles[profile].origin,
	mode: "local",
	section: "servers",
	loading: false,
	signIn: "idle",
	browserSignIn: null,
	webShellVersion: null,
	accounts: [],
});
let state: ShellState = initialState("hosted");
const settingsPath = () => join(app.getPath("userData"), "window.json");
const send = (event: string, data?: unknown) => {
	if (window && !window.isDestroyed()) window.webContents.send("laplace:event", { event, data });
	if (localPanel && !localPanel.webContents.isDestroyed())
		localPanel.webContents.send("laplace:event", { event, data });
};
const publish = () => {
	send("shell", state);
	if (web && !web.webContents.isDestroyed()) {
		web.webContents.send("laplace:local-state", !!state.localEmbedded);
		web.webContents.send("laplace:credentials-navigation", {
			active: !!state.localEmbedded && state.section === "credentials",
			pending: helper?.snapshot?.credentialRequests ?? 0,
		});
		web.webContents.send("laplace:update-available", !!updater?.state.availableVersion);
	}
};
const webSession = () => {
	const context = session.fromPartition(`persist:laplace-${state.profile}`);
	const userAgent = context.getUserAgent();
	if (!userAgent.split(/\s+/).includes(desktopUserAgentToken))
		context.setUserAgent(`${userAgent} ${desktopUserAgentToken}`);
	return context;
};
const profileRoot = () => join(app.getPath("userData"), "profiles", state.profile);

async function openExternal(url: string) {
	const safe = externalUrl(url);
	if (!safe) throw new Error("Unsupported external link.");
	await shell.openExternal(safe);
}

function protectWeb(contents: WebContents) {
	const profile = state.profile;
	const allowed = (url: string) => {
		try {
			return (
				permittedWebOrigin(profile, url) || (!!testOrigin && new URL(url).origin === testOrigin)
			);
		} catch {
			return false;
		}
	};
	const openWebExternal = async (url: string) => {
		const handoff = agentHandoffUrl(url, contents.getURL(), state.origin);
		if (handoff) await shell.openExternal(handoff);
		else await openExternal(url);
	};
	const navigation = (event: Electron.Event, url: string) => {
		if (allowed(url)) return;
		event.preventDefault();
		void openWebExternal(url).catch(() => {});
	};
	contents.on("will-navigate", (event, url) => {
		if (
			desktopLocalNavigation(contents === web?.webContents, contents.getURL(), url, state.origin)
		) {
			event.preventDefault();
			showLocal(new URL(url).pathname === "/desktop/credentials" ? "credentials" : "servers");
			return;
		}
		navigation(event, url);
	});
	contents.on("will-redirect", navigation);
	contents.setWindowOpenHandler(({ url }) => {
		if (url === "about:blank" || allowed(url)) {
			return {
				action: "allow",
				overrideBrowserWindowOptions: {
					width: 640,
					height: 780,
					show: url !== "about:blank",
					autoHideMenuBar: true,
					webPreferences: {
						nodeIntegration: false,
						contextIsolation: true,
						sandbox: true,
						webSecurity: true,
						session: webSession(),
						preload: undefined,
					},
				},
			};
		}
		void openWebExternal(url).catch(() => {});
		return { action: "deny" };
	});
	contents.on("did-create-window", (child) => {
		popups.add(child);
		// The web app first opens about:blank, then assigns OAuth URL asynchronously.
		protectWeb(child.webContents);
		const external = (_event: Electron.Event, url: string) => {
			if (!allowed(url))
				setImmediate(() => {
					if (!child.isDestroyed()) child.close();
				});
		};
		child.webContents.on("will-navigate", external);
		child.webContents.on("will-redirect", external);
		const lifetime = setTimeout(() => {
			if (!child.isDestroyed()) child.close();
		}, 5 * 60_000);
		child.on("closed", () => {
			clearTimeout(lifetime);
			popups.delete(child);
		});
	});
	contents.on("will-attach-webview", (event) => event.preventDefault());
}

/** Connect owns navigation; only the trusted local view may cover its content slot. */
function layout() {
	if (!window || window.isDestroyed()) return;
	const { width, height } = window.getContentBounds();
	const available = hostedReady && !!state.account && !state.webError;
	state.localEmbedded = !!(available && state.mode === "local" && contentLayout && localPanelReady);
	web?.setBounds({ x: 0, y: 0, width, height });
	web?.setVisible(available && (state.mode === "web" || !!state.localEmbedded));
	if (localPanel) {
		const rect = contentLayout;
		const zoom = web?.webContents.getZoomFactor() ?? 1;
		if (rect) {
			const x = Math.min(width, Math.max(0, Math.round(rect.x * zoom)));
			const y = Math.min(height, Math.max(0, Math.round(rect.y * zoom)));
			localPanel.setBounds({
				x,
				y,
				width: Math.max(0, Math.min(width - x, Math.round(rect.width * zoom))),
				height: Math.max(0, Math.min(height - y, Math.round(rect.height * zoom))),
			});
		}
		localPanel.setVisible(!!state.localEmbedded && !rect?.blocked);
	}
}

async function prepareLocalPanel() {
	if (localPanelReady) return;
	if (localPanelLoading) return localPanelLoading;
	localPanelLoading = (async () => {
		const panel = new WebContentsView({
			webPreferences: {
				preload: join(appRoot, "main", "preload.cjs"),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webSecurity: true,
			},
		});
		localPanel = panel;
		panel.setVisible(false);
		window.contentView.addChildView(panel);
		panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		panel.webContents.on("will-navigate", (event, url) => {
			if (!trustedRenderer(url, devUrl)) event.preventDefault();
		});
		panel.webContents.on("render-process-gone", () => {
			window.contentView.removeChildView(panel);
			localPanel = undefined;
			panel.webContents.close();
			localPanelReady = false;
			contentLayout = undefined;
			layout();
			publish();
		});
		try {
			const url = new URL(uiUrl);
			url.searchParams.set("contentOnly", "1");
			await panel.webContents.loadURL(url.href);
			localPanelReady = true;
			if (helper?.snapshot) send("snapshot", helper.snapshot);
		} catch {
			window.contentView.removeChildView(panel);
			panel.webContents.close();
			localPanel = undefined;
			contentLayout = undefined;
		} finally {
			localPanelLoading = undefined;
			layout();
			publish();
		}
	})();
	return localPanelLoading;
}

function destroyWeb() {
	hostedReady = false;
	contentLayout = undefined;
	state.localEmbedded = false;
	localPanel?.setVisible(false);
	for (const popup of popups) popup.destroy();
	if (web) {
		window.contentView.removeChildView(web);
		web.webContents.close();
		web = undefined;
	}
}

/** Show native content inside Connect when available, otherwise use the standalone manager. */
function showLocal(section?: LocalSection, discardWeb = false) {
	webGeneration++;
	state.mode = "local";
	if (section) state.section = section;
	state.loading = false;
	if (discardWeb) {
		lastWebUrl = undefined;
		destroyWeb();
	}
	layout();
	publish();
	if (window && !window.isDestroyed()) {
		if (state.localEmbedded) localPanel?.webContents.focus();
		else window.webContents.focus();
	}
	return state;
}

function clearAccount() {
	state.account = undefined;
	state.accounts = [];
	state.accountError = undefined;
}

let blockingAccount: Promise<void> | undefined;
async function blockAccountAccess() {
	if (blockingAccount) return blockingAccount;
	const manager = helper;
	if (!manager) return;
	blockingAccount = (async () => {
		await manager.request("link.block");
		await Promise.all(
			(manager.snapshot?.clients ?? [])
				.filter((client) => client.hosted !== "disconnected")
				.map((client) => manager.request("hosted.disconnect", { clientId: client.id })),
		);
	})();
	try {
		await blockingAccount;
	} finally {
		blockingAccount = undefined;
	}
}

function createWeb() {
	if (web) destroyWeb();
	const s = webSession(),
		profile = state.profile;
	const signOutFilter = {
		urls: [
			`${state.origin}/api/auth/sign-out*`,
			...(profile === "local" ? ["http://localhost:3004/api/auth/sign-out*"] : []),
		],
	};
	let embeddedSignOut: { id: number; ready: Promise<boolean> } | undefined;
	const finishEmbeddedSignOut = (id: number) => {
		const logout = embeddedSignOut;
		if (!logout || logout.id !== id) return;
		embeddedSignOut = undefined;
		void logout.ready
			.then(async (blocked) => {
				if (blocked) {
					await s.clearStorageData();
					if (profile === state.profile) showLocal(undefined, true);
				}
			})
			.catch(() => send("error", "Desktop sign-out could not clear this profile’s browser data."))
			.finally(() => {
				signingOut = false;
			});
	};
	s.webRequest.onCompleted(signOutFilter, (details) => finishEmbeddedSignOut(details.id));
	s.webRequest.onErrorOccurred(signOutFilter, (details) => finishEmbeddedSignOut(details.id));
	s.webRequest.onBeforeRequest(signOutFilter, (details, callback) => {
		if (
			details.method !== "POST" ||
			(details.webContentsId ?? 0) < 1 ||
			profile !== state.profile
		) {
			callback({});
			return;
		}
		if (!authenticationStable()) {
			callback({ cancel: true });
			return;
		}
		signingOut = true;
		const cancelled = invalidateAuth(),
			generation = profileGeneration;
		const ready = Promise.allSettled([blockAccountAccess(), cancelled]).then((results) =>
			results.every((result) => result.status === "fulfilled"),
		);
		embeddedSignOut = { id: details.id, ready };
		void ready.then((blocked) => {
			if (blocked) {
				if (generation === profileGeneration) {
					clearAccount();
					showLocal();
				}
				callback({});
			} else {
				callback({ cancel: true });
				finishEmbeddedSignOut(details.id);
			}
		});
	});
	s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	s.setPermissionCheckHandler(() => false);
	web = new WebContentsView({
		webPreferences: {
			preload: join(__dirname, "web-preload.cjs"),
			session: s,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			navigateOnDragDrop: false,
		},
	});
	window.contentView.addChildView(web);
	if (localPanel) window.contentView.addChildView(localPanel);
	protectWeb(web.webContents);
	const view = web;
	const isCurrent = () => view === web && profile === state.profile;
	view.webContents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
		if (!isCurrent() || !mainFrame || inPlace) return;
		// The local action is cancelled in will-navigate; it never replaces this document.
		if (desktopLocalNavigation(true, view.webContents.getURL(), url, state.origin)) return;
		contentLayout = undefined;
		if (state.localEmbedded) state.mode = "web";
		layout();
		publish();
	});
	const track = (_event: Electron.Event, url: string) => {
		if (!isCurrent()) return;
		if (webSessionEnded(url, state.origin)) {
			state.webError = "Your Laplace session ended. Sign in again to continue.";
			showLocal();
			void signedInAccount().catch(() => {});
			return;
		}
		if (new URL(url).origin === state.origin) lastWebUrl = url;
		if (state.localEmbedded) {
			state.mode = "web";
			layout();
			publish();
		}
	};
	view.webContents.on("did-navigate", track);
	view.webContents.on("did-navigate-in-page", (event, url, mainFrame) => {
		if (mainFrame) track(event, url);
	});
	view.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
		if (!isCurrent() || !mainFrame || code === -3) return;
		state.webError =
			state.profile === "local"
				? "Local Laplace is unavailable. Start the Connect development server on port 3004, then retry."
				: "Laplace could not load. Check your internet connection and retry.";
		hostedReady = false;
		showLocal();
	});
	view.webContents.on("render-process-gone", () => {
		if (!isCurrent()) return;
		state.webError = "Laplace stopped unexpectedly. Retry to reconnect.";
		hostedReady = false;
		showLocal();
	});
	layout();
}

async function loadWeb(url: string, generation: number) {
	if (!web) createWeb();
	hostedReady = false;
	state.loading = true;
	layout();
	publish();
	const view = web;
	try {
		await view?.webContents.loadURL(url);
		if (generation !== webGeneration || view !== web) return;
		hostedReady = true;
		state.loading = false;
		layout();
		publish();
	} catch (error) {
		if (generation === webGeneration && view === web && !state.webError) throw error;
	}
}

/** Show Connect itself, reopening the last page unless a reload is requested. */
async function showWeb(reload = false) {
	const generation = ++webGeneration;
	state.webError = undefined;
	if (!state.account) {
		showLocal();
		throw new Error("Sign in to Laplace to open your workspace.");
	}
	state.mode = "web";
	publish();
	try {
		if (state.webShellVersion === null) await readCapabilities();
		if (generation !== webGeneration) return state;
		if (!state.webShellVersion)
			throw new Error(
				"This Laplace server needs an update to open in Desktop. Your local tools remain available.",
			);
		if (!web || !hostedReady || reload)
			await loadWeb(restorableWebUrl(lastWebUrl, state.origin), generation);
		else {
			layout();
			publish();
		}
		if (generation === webGeneration && state.mode === "web") web?.webContents.focus();
	} catch (error) {
		if (generation === webGeneration) {
			state.webError = (error as Error).message;
			showLocal();
		}
	}
	return state;
}

const sessionContext = () => ({ origin: state.origin, session: webSession() });
class SessionRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
async function sessionJson(
	path: string,
	body?: unknown,
	context = sessionContext(),
	signal?: AbortSignal,
) {
	const response = await context.session.fetch(`${context.origin}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "Content-Type": "application/json", Origin: context.origin },
		body: body === undefined ? undefined : JSON.stringify(body),
		credentials: "include",
		redirect: "error",
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
			: AbortSignal.timeout(15_000),
	});
	if (!response.ok)
		throw new SessionRequestError(
			response.status,
			response.status === 404
				? "This Laplace server has not deployed desktop support yet. Switch to Local development to test the full flow."
				: response.status === 401
					? "Sign in to Laplace first."
					: "Laplace could not complete this request. Please retry.",
		);
	return response.json();
}

async function authJson(
	path: string,
	body: unknown,
	context: ReturnType<typeof sessionContext>,
	signal: AbortSignal,
) {
	const request = sessionJson(path, body, context, signal);
	pendingAuth.add(request);
	try {
		return await request;
	} finally {
		pendingAuth.delete(request);
	}
}

async function signedInAccount() {
	const generation = profileGeneration,
		context = sessionContext(),
		signal = authController.signal;
	try {
		const result = await requireLaplaceSession(
			() => authJson("/api/desktop/accounts", undefined, context, signal),
			() => generation === profileGeneration && authenticationStable(),
		);
		state.account = result.user;
		state.accounts = result.accounts;
		state.accountError = undefined;
		layout();
		publish();
		return result;
	} catch (error) {
		if (generation === profileGeneration && authenticationStable()) {
			if (error instanceof SessionRequestError && error.status === 401) {
				clearAccount();
				showLocal(undefined, true);
			} else {
				state.accountError =
					"Account features are temporarily unavailable. Your local tools remain available.";
				layout();
				publish();
			}
		}
		throw error;
	}
}

async function readCapabilities() {
	const generation = profileGeneration;
	const capabilities = await sessionJson("/api/desktop/capabilities");
	if (generation !== profileGeneration) return;
	state.browserSignIn = capabilities.browserSignIn === true;
	state.localContentVersion = capabilities.localContentVersion === 1 ? 1 : 0;
	state.webShellVersion = Number.isInteger(capabilities.webShellVersion)
		? capabilities.webShellVersion
		: 0;
}

/** Refresh the signed-in account; `open` shows Connect once the account is confirmed. */
async function refreshAccount(open = false) {
	const profile = state.profile,
		generation = profileGeneration;
	let restored = false;
	try {
		await readCapabilities();
		if (profile !== state.profile || generation !== profileGeneration) return;
		await signedInAccount();
		restored = true;
	} catch (error) {
		if (profile !== state.profile || generation !== profileGeneration) return;
		if (state.browserSignIn === null) state.browserSignIn = false;
		if (error instanceof SessionRequestError && error.status === 401)
			state.accountError = undefined;
		else state.accountError ??= "Account features are temporarily unavailable. Please retry.";
	}
	layout();
	publish();
	if (open && restored && profile === state.profile && generation === profileGeneration)
		await showWeb();
}

function restoreAccount() {
	const generation = profileGeneration,
		context = sessionContext();
	void restorePersistedAccount(
		async () => (await context.session.cookies.get({ url: context.origin })).length > 0,
		() => generation === profileGeneration,
		() => refreshAccount(true),
	).catch(() => {});
}

let notificationSyncBusy = false;
async function syncDesktopNotifications() {
	if (notificationSyncBusy || !helper?.snapshot || !state.account || !authenticationStable())
		return;
	notificationSyncBusy = true;
	const manager = helper,
		snapshot = helper.snapshot,
		generation = profileGeneration,
		userId = state.account.id,
		context = sessionContext(),
		signal = authController.signal;
	const current = () =>
		manager === helper &&
		generation === profileGeneration &&
		state.account?.id === userId &&
		authenticationStable() &&
		manager.snapshot?.installationId === snapshot.installationId &&
		manager.snapshot?.accountId === snapshot.accountId;
	try {
		await syncSetupNotifications({
			snapshot,
			current,
			send: (body) => authJson("/api/desktop/setup-notifications", body, context, signal),
			acknowledge: (owner, ids) =>
				manager.request("catalog.notificationsDelivered", { owner, ids }),
		});
	} catch {
		/* Persisted results remain visible and retry when connectivity returns. */
	} finally {
		notificationSyncBusy = false;
	}
}
setInterval(() => {
	void syncDesktopNotifications();
}, 20_000).unref();

async function startHelper() {
	state.helperError = undefined;
	await mkdir(profileRoot(), { recursive: true, mode: 0o700 });
	await writeFile(
		join(profileRoot(), "launcher.json"),
		JSON.stringify({
			executable: process.execPath,
			args: [...(app.isPackaged ? [] : [app.getAppPath()]), `--laplace-profile=${state.profile}`],
		}),
		{ mode: 0o600 },
	);
	const next = new HelperClient(
		(event) => {
			if (event.event === "desktop-open") {
				showLocal(event.section);
				window?.show();
				window?.focus();
			} else if (event.event === "open-url") void openExternal(event.url).catch(() => {});
			else if (event.event === "snapshot") {
				send("snapshot", event.data);
				publish();
				void syncDesktopNotifications();
			} else if (event.event === "broker-unlock") {
				showLocal("credentials");
				window?.show();
				window?.focus();
				state.unlockSessionId = event.sessionId;
				publish();
			} else if (event.event === "broker-focus") {
				showLocal("servers");
				window?.show();
				window?.focus();
				send("broker-focus", {});
			} else if (event.event === "browser-approval") {
				showLocal("servers");
				window?.show();
				window?.focus();
				send("browser-approval", event.requestId);
			}
		},
		(message) => {
			state.helperError = message;
			publish();
		},
	);
	helper = next;
	try {
		await next.start(
			profileRoot(),
			resources,
			state.origin,
			join(app.isPackaged ? resources : appRoot, "helper", "main.cjs"),
		);
	} catch (error) {
		state.helperError = (error as Error).message;
	}
	publish();
}

async function selectProfile(profile: Profile) {
	if (profile === state.profile || changingProfile) return;
	requireStableAuthentication(authenticationStable);
	changingProfile = true;
	try {
		const choice = await dialog.showMessageBox(window, {
			type: "question",
			buttons: ["Switch profile", "Cancel"],
			defaultId: 0,
			cancelId: 1,
			message: `Switch to ${profiles[profile].name}?`,
			detail:
				"The current profile’s MCP processes will stop. Each profile has separate servers, credentials, and AI-client registrations.",
		});
		if (choice.response !== 0) return;
		void invalidateAuth();
		signIn?.cancel();
		signIn = undefined;
		showLocal(undefined, true);
		await helper?.stop();
		state = { ...initialState(profile), section: "device" };
		await startHelper();
		restoreAccount();
		saveWindow();
	} finally {
		changingProfile = false;
	}
}

function saveWindow() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		if (!window.isDestroyed())
			void writeFile(
				settingsPath(),
				JSON.stringify({
					profile: state.profile,
					bounds: window.getNormalBounds(),
					maximized: window.isMaximized(),
				}),
				{ mode: 0o600 },
			).catch(() => {});
	}, 300);
}

async function handleShell(raw: unknown) {
	const request = shellRequest.parse(raw);
	switch (request.method) {
		case "shell.point.status":
			return point?.state;
		case "shell.point.configure":
			if (!point) throw new Error("Point is still starting.");
			return point.configure(request.input);
		case "shell.point.capture":
			if (!point) throw new Error("Point is still starting.");
			void point.capture();
			return;
		case "shell.point.retry":
			return point?.retry();
		case "shell.point.copy":
			return point?.copy();
		case "shell.point.clear":
			return point?.clear();
		case "shell.point.permissions":
			return point?.requestPermissions();
		case "shell.updateChanges":
			if (updater?.state.availableVersion) {
				await openExternal(
					`https://github.com/acriver3/laplace-desktop/releases/tag/desktop-v${encodeURIComponent(updater.state.availableVersion)}`,
				);
			}
			return;
		case "shell.updateCheck":
			void updater?.check();
			return;
		case "shell.updateDownload":
			void updater?.download();
			return;
		case "shell.updateCancel":
			await updater?.cancel();
			return;
		case "shell.updateInstall": {
			if (!updater) throw new Error("Source updates are not configured.");
			await updater.handoff();
			clearTimeout(saveTimer);
			await writeFile(
				settingsPath(),
				JSON.stringify({
					profile: state.profile,
					bounds: window.getNormalBounds(),
					maximized: window.isMaximized(),
				}),
				{ mode: 0o600 },
			);
			app.quit();
			return;
		}
		case "shell.catalogSetup": {
			const current = helper,
				generation = profileGeneration;
			if (!current || changingProfile)
				throw new Error("Wait for Laplace to finish starting, then try again.");
			const entries = (await current.request("catalog.list", {})) as SetupCatalogEntry[];
			if (helper !== current || generation !== profileGeneration || changingProfile)
				throw new Error("Your Laplace profile changed. Please prepare setup again.");
			const entry = entries.find((item) => item.id === request.input.catalogId);
			if (!entry?.available) throw new Error("This connector is not available on this device.");
			const prompt = catalogSetupPrompt(entry, profiles[state.profile].name);
			const destination = catalogSetupDestination(request.input.target, prompt);
			let opened = false;
			if (request.input.action === "open" && destination) {
				try {
					await shell.openExternal(destination);
					opened = true;
				} catch {
					/* Return the full prompt for the copy fallback. */
				}
			}
			return { prompt, opened };
		}
		case "shell.brokerSetup": {
			const current = helper,
				generation = profileGeneration;
			if (!current || changingProfile) throw Error("Wait for Desktop to finish starting.");
			await current.request("broker.stage", {
				clientId: request.input.clientId,
				sessionId: request.input.sessionId,
				targets: request.input.targets,
			});
			if (helper !== current || generation !== profileGeneration || changingProfile)
				throw Error("Desktop profile changed.");
			const prompt =
				"Continue my Laplace connection request " +
				request.input.sessionId +
				". Use local_credential_broker status with this sessionId to retrieve its targets, then start the same session with those targets to prepare hosted authorization if needed. Show local_credential_broker_show in chat. Use readiness to guide setup; never request secrets. OAuth may continue in existing Chrome without vault access. The user approves credentials in the card; Desktop continues automatically. Do not replay business actions.";
			const destination = assistantSetupDestination(request.input.target, prompt);
			let opened = false;
			if (request.input.action === "open" && destination) {
				try {
					await shell.openExternal(destination);
					opened = true;
				} catch {
					/* copy fallback */
				}
			}
			return { prompt, opened };
		}
		case "shell.assistantSetup": {
			const current = helper,
				generation = profileGeneration;
			if (!current || changingProfile)
				throw new Error("Wait for Laplace to finish starting, then try again.");
			const preview = (await current.request("client.preview-install", {
				clientId: request.input.clientId,
				client: "other",
			})) as { entry: { command: string; args: string[] } };
			if (helper !== current || generation !== profileGeneration || changingProfile)
				throw new Error("Your Laplace profile changed. Please prepare setup again.");
			const prompt = assistantSetupPrompt(request.input.target, preview.entry);
			const destination = assistantSetupDestination(request.input.target, prompt);
			let opened = false;
			if (request.input.action === "open" && destination) {
				try {
					// Trusted desktop IPC only; never accept arbitrary protocol URLs from a renderer.
					await shell.openExternal(destination);
					opened = true;
				} catch {
					/* The UI retains the complete prompt for copy/paste. */
				}
			}
			return { prompt, opened };
		}
		case "shell.dismissUnlock":
			state.unlockSessionId = undefined;
			publish();
			return;
		case "shell.status":
			return state;
		case "shell.local":
			return showLocal(request.input.section);
		case "shell.web":
			return showWeb();
		case "shell.profile":
			await selectProfile(request.input.profile);
			return state;
		case "shell.reload":
			if (state.account) return showWeb(true);
			return state;
		case "shell.accounts":
			await refreshAccount();
			return state;
		case "shell.pickImport": {
			const result = await dialog.showOpenDialog(window, {
				properties: ["openFile"],
				filters: [{ name: "MCP configuration", extensions: ["json", "toml"] }],
			});
			return result.canceled ? null : result.filePaths[0];
		}
		case "shell.pickBundles": {
			const result = await dialog.showOpenDialog(window, {
				properties: ["openFile", "multiSelections"],
				filters: [{ name: "MCP bundles", extensions: ["mcpb"] }],
			});
			return result.canceled ? [] : result.filePaths;
		}
		case "shell.pickDirectory": {
			const result = await dialog.showOpenDialog(window, {
				properties: ["openDirectory", "createDirectory"],
			});
			return result.canceled ? null : result.filePaths[0];
		}
		case "shell.signIn": {
			requireStableAuthentication(authenticationStable);
			if (signIn || startingSignIn) return state;
			startingSignIn = true;
			const generation = profileGeneration,
				context = sessionContext(),
				signal = authController.signal;
			showLocal();
			try {
				const capabilities = await sessionJson("/api/desktop/capabilities", undefined, context);
				if (generation !== profileGeneration || !authenticationStable())
					throw new Error("Profile changed. Start sign-in again.");
				state.localContentVersion = capabilities.localContentVersion === 1 ? 1 : 0;
				state.webShellVersion = Number.isInteger(capabilities.webShellVersion)
					? capabilities.webShellVersion
					: 0;
				if (!capabilities.browserSignIn)
					throw new Error("Browser sign-in is not available on this server yet.");
				const profile = state.profile;
				const flow = await beginBrowserSignIn(context.origin, async (body) => {
					if (generation !== profileGeneration || !authenticationStable())
						throw new Error("Profile changed. Start sign-in again.");
					await authJson("/api/auth/desktop/exchange", body, context, signal);
				});
				if (generation !== profileGeneration || !authenticationStable()) {
					flow.cancel();
					throw new Error("Profile changed. Start sign-in again.");
				}
				signIn = flow;
				state.signIn = "waiting";
				publish();
				const current = signIn;
				void current.completed
					.then(async () => {
						if (state.profile !== profile || signIn !== current) return;
						state.signIn = "complete";
						window.show();
						window.focus();
						await refreshAccount(true);
					})
					.catch((error: Error) => {
						if (signIn === current) send("error", error.message);
					})
					.finally(() => {
						if (signIn === current) {
							signIn = undefined;
							state.signIn = "idle";
							publish();
						}
					});
				await openExternal(current.url);
				return state;
			} finally {
				startingSignIn = false;
			}
		}
		case "shell.cancelSignIn":
			requireStableAuthentication(authenticationStable);
			await invalidateAuth();
			signIn?.cancel();
			signIn = undefined;
			state.signIn = "idle";
			publish();
			return state;
		case "shell.signOut": {
			requireStableAuthentication(authenticationStable);
			signingOut = true;
			const cancelled = invalidateAuth();
			const generation = profileGeneration,
				context = sessionContext();
			signIn?.cancel();
			signIn = undefined;
			clearAccount();
			showLocal(undefined, true);
			// Stop desktop access before attempting a network logout. Offline
			// failure must not leave linked tools or hosted tokens usable.
			try {
				await blockAccountAccess();
				try {
					await sessionJson("/api/auth/sign-out", {}, context);
				} catch {
					/* local logout still completes */
				}
				await cancelled;
				await context.session.clearStorageData();
				if (generation !== profileGeneration) return state;
				state.account = undefined;
				state.accounts = [];
				state.signIn = "idle";
				publish();
				return state;
			} finally {
				await cancelled;
				signingOut = false;
			}
		}
		case "shell.link": {
			if (!helper) throw new Error("Local manager is unavailable.");
			await signedInAccount();
			const manager = helper,
				generation = profileGeneration,
				context = sessionContext(),
				signal = authController.signal;
			const preparation = await manager.request<{
				credentialHash: string;
				installationId?: string;
			}>("link.prepare", { origin: context.origin });
			if (generation !== profileGeneration)
				throw new Error("Profile changed. Select an account again.");
			const linked = await authJson(
				"/api/desktop/link",
				{ accountId: request.input.accountId, name: request.input.name, ...preparation },
				context,
				signal,
			);
			if (generation !== profileGeneration)
				throw new Error("Profile changed. Select an account again.");
			await manager.request("link.complete", {
				origin: context.origin,
				installationId: linked.installationId,
				accountId: linked.accountId,
			});
			return manager.snapshot;
		}
		case "shell.quit":
			app.quit();
			return null;
	}
}

async function createWindow() {
	let saved: { profile?: Profile; bounds?: Electron.Rectangle; maximized?: boolean } = {};
	try {
		saved = JSON.parse(await readFile(settingsPath(), "utf8"));
	} catch {}
	const profile = requestedProfile ?? (saved.profile === "local" ? "local" : "hosted");
	state.profile = profile;
	state.origin = testOrigin ?? profiles[profile].origin;
	const bounds =
		saved.bounds &&
		screen.getAllDisplays().some((display) => {
			const a = display.workArea,
				b = saved.bounds!;
			return (
				b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
			);
		})
			? saved.bounds
			: { width: 1200, height: 820 };
	window = new BrowserWindow({
		...bounds,
		minWidth: 900,
		minHeight: 600,
		title: "Laplace",
		backgroundColor: "#f8fafc",
		show: false,
		autoHideMenuBar: process.platform !== "darwin",
		webPreferences: {
			preload: join(appRoot, "main", "preload.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
		},
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event, url) => {
		if (!trustedRenderer(url, devUrl)) event.preventDefault();
	});
	window.on("close", (event) => {
		if (!quitting) {
			event.preventDefault();
			window.hide();
		}
	});
	window.on("resize", () => {
		layout();
		saveWindow();
	});
	window.on("move", saveWindow);
	window.on("maximize", saveWindow);
	window.on("unmaximize", saveWindow);
	window.webContents.on("did-finish-load", () => {
		publish();
		if (helper?.snapshot) send("snapshot", helper.snapshot);
	});
	await window.loadURL(uiUrl);
	if (saved.maximized) window.maximize();
	if (!updateProbe) window.show();
	await startHelper();
	if (updateProbe) {
		if (state.helperError) throw new Error(`Update probe helper failed: ${state.helperError}`);
		await writeFile(
			join(app.getPath("userData"), "update-probe.json"),
			JSON.stringify({ nonce: updateProbe, version: app.getVersion() }),
			{ mode: 0o600 },
		);
		setTimeout(() => app.quit(), 100);
	} else restoreAccount();
}

const pendingBundles = new Set(
	process.argv.filter((arg) => isAbsolute(arg) && extname(arg).toLowerCase() === ".mcpb"),
);
async function openBundles(files: string[]) {
	for (const file of files)
		if (isAbsolute(file) && extname(file).toLowerCase() === ".mcpb") pendingBundles.add(file);
	if (!helper || !window) return;
	showLocal();
	window.show();
	window.focus();
	for (const file of [...pendingBundles]) {
		pendingBundles.delete(file);
		await helper.request("portable.install", {
			bundleFile: file,
			configuration: {},
			idempotencyKey: randomUUID(),
		});
	}
}
app.on("open-file", (event, file) => {
	event.preventDefault();
	void openBundles([file]).catch(() => send("error", "The MCPB bundle could not be opened."));
});
app.on("second-instance", (_event, _argv, _directory, data) => {
	void openBundles(_argv).catch(() => send("error", "The MCPB bundle could not be opened."));
	window?.show();
	window?.focus();
	const requested = (data as { profile?: unknown } | undefined)?.profile;
	if (window && (requested === "local" || requested === "hosted") && requested !== state.profile) {
		void dialog.showMessageBox(window, {
			type: "info",
			message: `An AI client needs the ${profiles[requested].name} profile.`,
			detail:
				"Switch profiles using the selector in Laplace, then reconnect the AI client. The current profile continues running until you choose to switch.",
		});
	}
});
app.on("activate", () => {
	window?.show();
	window?.focus();
});
app.on("window-all-closed", () => {});
function quitLaplace(exitCode = 0) {
	if (quitting) return;
	quitting = true;
	signIn?.cancel();
	clearTimeout(saveTimer);
	void Promise.allSettled([updater?.stop(), helper?.stop(), point?.stop()]).then(() => {
		tray?.destroy();
		// Renderer unload handlers must not veto an explicit application quit.
		app.exit(exitCode);
	});
}
app.on("before-quit", (event) => {
	event.preventDefault();
	quitLaplace();
});

void app
	.whenReady()
	.then(async () => {
		if (!primaryInstance) return;
		if (browserConnectionsEnabled() && app.isPackaged && !process.env.LAPLACE_DESKTOP_TEST_ROOT)
			await registerBrowserNativeHost(resources).catch(() => {
				console.error("Laplace browser extension discovery registration failed.");
			});
		await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
		registerRendererProtocol(session.defaultSession, appRoot);
		ipcMain.handle("laplace:web-shell", async (event, raw: unknown) => {
			if (
				!connectClipboardWrite(
					event.sender === web?.webContents,
					event.senderFrame === event.sender.mainFrame,
					event.senderFrame?.url,
					state.origin,
				)
			)
				throw new Error("Unauthorized shell presentation request.");
			const request = webShellRequest.parse(raw);
			if (request.kind === "credentials-navigation")
				return {
					active: !!state.localEmbedded && state.section === "credentials",
					pending: helper?.snapshot?.credentialRequests ?? 0,
				};
			if (request.kind === "status") return !!state.localEmbedded;
			if (request.kind === "update-status") return !!updater?.state.availableVersion;
			if (request.kind === "show-updates") {
				showLocal("updates");
				return;
			}
			if (request.kind === "web") {
				// A route may unmount its slot before requesting hosted content.
				if (state.mode === "local" && hostedReady && state.account && !state.webError) {
					state.mode = "web";
					layout();
					publish();
					web?.webContents.focus();
				}
				return;
			}
			if (state.localContentVersion !== 1) return;
			contentLayout = request.rect ?? undefined;
			if (contentLayout) await prepareLocalPanel();
			layout();
			publish();
		});
		ipcMain.handle("laplace:clipboard-write", async (event, text: unknown) => {
			if (
				!connectClipboardWrite(
					event.sender === web?.webContents,
					event.senderFrame === event.sender.mainFrame,
					event.senderFrame?.url,
					state.origin,
				) ||
				typeof text !== "string" ||
				text.length > 1_000_000
			)
				throw new Error("Clipboard write unavailable.");
			await clipboard.writeText(text);
		});
		ipcMain.handle("laplace:request", async (event, raw: unknown) => {
			if (
				(event.sender !== window.webContents && event.sender !== localPanel?.webContents) ||
				event.senderFrame !== event.sender.mainFrame ||
				!trustedRenderer(event.senderFrame.url, devUrl)
			)
				throw new Error("Unauthorized desktop request.");
			if (!raw || typeof raw !== "object" || !("method" in raw) || typeof raw.method !== "string")
				throw new Error("Invalid desktop request.");
			if (raw.method.startsWith("shell.")) return handleShell(raw);
			const method = raw.method as HelperMethod;
			if (!(method in helperInputs) || privateHelperMethods.has(method))
				throw new Error("Unsupported desktop operation.");
			const input = helperInputs[method].parse("input" in raw ? raw.input : {});
			if (!helper) throw new Error("Local manager is unavailable.");
			const manager = helper;
			if (requiresLaplaceSignIn(method)) await signedInAccount();
			if (manager !== helper) throw new Error("Desktop profile changed. Try again.");
			return manager.request(method, input);
		});
		await createWindow();
		await openBundles([]);
		point = new PointController({
			resources,
			appRoot,
			uiUrl,
			changed: (value) => send("point", value),
			attention: () => {
				showLocal("device");
				window.show();
				window.focus();
			},
		});
		await point.initialize().catch((error) => point?.initializationFailed(error));
		if (updateAcceptance && !state.helperError)
			await acknowledgeUpdate(
				updateAcceptance,
				app.getVersion(),
				process.env.LAPLACE_DESKTOP_TEST_ROOT
					? process.env.LAPLACE_DESKTOP_TEST_UPDATE_ROOT
					: undefined,
			);
		if (app.isPackaged && !updateProbe && !process.env.LAPLACE_DESKTOP_TEST_ROOT) {
			updater = new SourceUpdater(app.getVersion(), process.execPath, (updates) => {
				state.updates = updates;
				publish();
			});
			await updater.initialize();
		}
		const lockCredentials = () => {
			point?.suspend();
			void helper?.request("credentials.lock", {}).catch(() => {});
		};
		powerMonitor.on("suspend", lockCredentials);
		powerMonitor.on("resume", () => {
			void helper?.request("browser.resumeRecovery", {}).catch(() => {});
		});
		powerMonitor.on("lock-screen", lockCredentials);
		const icon = nativeImage.createFromPath(join(resources, "icon.png"));
		tray = new Tray(icon.resize({ width: 18, height: 18 }));
		tray.setToolTip("Laplace — local MCPs running");
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{
					label: "Capture with Point",
					click: () => {
						void point?.capture();
					},
				},
				{
					label: "Open Laplace",
					click: () => {
						window.show();
						window.focus();
					},
				},
				{
					label: "On this device",
					click: () => {
						showLocal();
						window.show();
					},
				},
				{ type: "separator" },
				{ label: "Quit Laplace", click: () => setImmediate(quitLaplace) },
			]),
		);
		tray.on("click", () => {
			window.show();
			window.focus();
		});
		Menu.setApplicationMenu(
			Menu.buildFromTemplate([
				...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
				{
					label: "File",
					submenu: [
						{
							label: "Open MCPB bundles",
							accelerator: "CmdOrCtrl+O",
							click: () => {
								void dialog
									.showOpenDialog(window, {
										properties: ["openFile", "multiSelections"],
										filters: [{ name: "MCP bundles", extensions: ["mcpb"] }],
									})
									.then((result) => openBundles(result.filePaths))
									.catch(() => send("error", "The MCPB bundle could not be opened."));
							},
						},
						{
							label: "Laplace",
							accelerator: "CmdOrCtrl+1",
							click: () => {
								void showWeb().catch((error: Error) => send("error", error.message));
							},
						},
						{
							label: "On this device",
							accelerator: "CmdOrCtrl+2",
							click: () => {
								showLocal();
							},
						},
						{ role: "close" },
						{ role: "quit" },
					],
				},
				{ role: "editMenu" },
				{
					label: "View",
					submenu: [
						{
							label: "Reload",
							accelerator: "CmdOrCtrl+R",
							click: () =>
								void handleShell({ method: "shell.reload" }).catch((error: Error) =>
									send("error", error.message),
								),
						},
						{ role: "resetZoom" },
						{ role: "zoomIn" },
						{ role: "zoomOut" },
						{ role: "togglefullscreen" },
						...(!app.isPackaged
							? [
									{
										label: "Developer tools",
										accelerator: "CmdOrCtrl+Shift+I",
										click: () => window.webContents.toggleDevTools(),
									},
								]
							: []),
					],
				},
				{ role: "windowMenu" },
			]),
		);
	})
	.catch((error: Error) => {
		if (updateProbe) {
			console.error(error.message);
			app.exit(1);
			return;
		}
		dialog.showErrorBox("Laplace could not start", error.message);
		quitLaplace(1);
	});
