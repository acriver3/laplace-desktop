import { connectBroker } from "./broker.js";
import { provider } from "./providers.js";
const prefix = "laplaceBrowserApproval:";
const pumping = new Set();

function pairing(value) {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		!url.port ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		!/^#[A-Za-z0-9_-]{43}$/.test(url.hash)
	)
		throw new Error("Invalid Desktop request.");
	return { base: url.origin, code: url.hash.slice(1) };
}
async function request(base, path, body, token) {
	const response = await fetch(base + path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: "Bearer " + token } : {}),
		},
		body: JSON.stringify(body),
		credentials: "omit",
		redirect: "error",
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok)
		throw new Error(
			"Desktop request expired or disconnected. Ask your agent to authenticate again.",
		);
	return response.json();
}
const chunkSize = 192 * 1024;
const maxTransferBytes = 32 * 1024 * 1024;
const encodeChunk = (bytes) => {
	let text = "";
	for (let i = 0; i < bytes.length; i += 8192)
		text += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(text);
};
const transferDigest = async (bytes) =>
	[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
async function requestArguments(stored, next) {
	const transfer = next.argumentsTransfer;
	if (!transfer) return next.args;
	if (
		!Number.isSafeInteger(transfer.bytes) ||
		transfer.bytes < 1 ||
		transfer.bytes > maxTransferBytes ||
		transfer.chunks !== Math.ceil(transfer.bytes / chunkSize) ||
		!/^[a-f0-9]{64}$/.test(transfer.sha256)
	)
		throw Error("Invalid arguments transfer.");
	const bytes = new Uint8Array(transfer.bytes);
	for (let index = 0; index < transfer.chunks; index++) {
		const { data } = await request(
			stored.base,
			"/arguments-chunk",
			{ id: next.id, index },
			stored.token,
		);
		if (typeof data !== "string" || data.length > chunkSize * 2)
			throw Error("Invalid arguments chunk.");
		const decoded = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
		if (decoded.length !== Math.min(chunkSize, transfer.bytes - index * chunkSize))
			throw Error("Invalid arguments chunk size.");
		bytes.set(decoded, index * chunkSize);
	}
	if ((await transferDigest(bytes)) !== transfer.sha256)
		throw Error("Arguments checksum mismatch.");
	return JSON.parse(new TextDecoder().decode(bytes));
}
async function sendResult(stored, next, value) {
	// Older relays have no chunk protocol. Preserve their existing JSON path.
	if (next.resultLimit === undefined)
		return request(stored.base, "/result", { id: next.id, ...value }, stored.token);
	if (!value.ok) return request(stored.base, "/result", { id: next.id, ok: false }, stored.token);
	const bytes = new TextEncoder().encode(JSON.stringify(value.result) ?? "null");
	const limit = next.resultLimit ?? 1024 * 1024;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxTransferBytes || bytes.length > limit)
		throw Error("Response exceeds operation limit.");
	if (bytes.length <= 512 * 1024)
		return request(
			stored.base,
			"/result",
			{ id: next.id, ok: true, result: value.result },
			stored.token,
		);
	const description = {
		bytes: bytes.length,
		sha256: await transferDigest(bytes),
		chunks: Math.ceil(bytes.length / chunkSize),
	};
	for (let index = 0; index < description.chunks; index++) {
		await request(
			stored.base,
			"/result-chunk",
			{
				id: next.id,
				index,
				data: encodeChunk(bytes.subarray(index * chunkSize, (index + 1) * chunkSize)),
				...(index === 0 ? { description } : {}),
			},
			stored.token,
		);
	}
	return request(stored.base, "/result", { id: next.id, ok: true, transfer: true }, stored.token);
}
async function inTab(tabId, adapter, method, args, expected, workspace = expected?.workspace) {
	if (method !== adapter.identify && !adapter.methods.includes(method)) return { ok: false };
	const results = await chrome.scripting.executeScript({
		target: { tabId },
		world: "ISOLATED",
		func: adapter.read,
		args: [method, args, expected, workspace],
	});
	return results.find((r) => r.frameId === 0)?.result ?? { ok: false };
}
async function sessions() {
	const all = await chrome.storage.session.get(null);
	return Object.entries(all)
		.filter(([key]) => key.startsWith(prefix))
		.map(([key, value]) => ({ id: key.slice(prefix.length), ...value }));
}
async function badge() {
	const all = await sessions();
	await chrome.action.setBadgeText({ text: all.length ? String(all.length) : "" });
}
async function disconnect(id, token, revoke = false) {
	const key = prefix + id,
		stored = (await chrome.storage.session.get(key))[key];
	if (!stored || (token && stored.token !== token)) return;
	await chrome.storage.session.remove(key);
	const revocationKey = "revoke:" + stored.provider + ":" + stored.identity.workspace;
	if (revoke) {
		await chrome.storage.local.set({ [revocationKey]: stored.identity });
		await request(stored.base, "/revoke-consent", {}, stored.token);
		await chrome.storage.local.remove(revocationKey);
	} else await request(stored.base, "/pause", {}, stored.token).catch(() => {});
	await badge();
}
async function pump(id) {
	if (pumping.has(id)) return;
	pumping.add(id);
	try {
		while (true) {
			const key = prefix + id,
				stored = (await chrome.storage.session.get(key))[key];
			if (!stored) return;
			if (Date.now() >= stored.expiresAt) {
				await disconnect(id, stored.token);
				return;
			}
			try {
				const adapter = provider(stored.provider);
				const { request: next } = await request(stored.base, "/next", {}, stored.token);
				if (next) {
					const value = await inTab(
						stored.tabId,
						adapter,
						next.method,
						await requestArguments(stored, next),
						stored.identity,
					).catch(() => ({ ok: false }));
					await sendResult(stored, next, value);
					if (!value.ok) {
						await disconnect(id, stored.token);
						return;
					}
				}
			} catch {
				await disconnect(id, stored.token);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	} finally {
		pumping.delete(id);
	}
}

let port;
let reconnect;
const processing = new Set();
const discoveries = new Map();
let profilePromise;
function profile() {
	return (profilePromise ??= chrome.storage.local.get("profileId").then(async (value) => {
		const profileId = value.profileId || crypto.randomUUID();
		await chrome.storage.local.set({ profileId });
		return {
			profileId,
			profileLabel:
				(navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome") + " · " + profileId.slice(0, 6),
		};
	}));
}
async function accept(items) {
	const incoming = new Set();
	for (const item of items.slice(0, 16)) {
		if (!/^[0-9a-f-]{36}$/.test(item.id) || Date.parse(item.expiresAt) <= Date.now()) continue;
		try {
			provider(item.provider);
			pairing(item.pairingUrl);
		} catch {
			continue;
		}
		incoming.add(item.id);
		const prior = discoveries.get(item.id);
		if (!prior || prior.item.pairingUrl !== item.pairingUrl)
			discoveries.set(item.id, { item, identities: new Map() });
		else prior.item = item;
	}
	for (const id of discoveries.keys()) if (!incoming.has(id)) discoveries.delete(id);
	await refresh();
}
async function inspect(entry) {
	const { item } = entry;
	if (processing.has(item.id) || Date.parse(item.expiresAt) <= Date.now()) return;
	processing.add(item.id);
	try {
		const target = pairing(item.pairingUrl),
			adapter = provider(item.provider),
			browser = await profile();
		const desired = await request(target.base, "/describe", { code: target.code });
		if (desired.provider !== item.provider || desired.workspace !== item.workspace) return;
		const revocationKey = "revoke:" + item.provider + ":" + item.workspace;
		const revoked = (await chrome.storage.local.get(revocationKey))[revocationKey];
		if (revoked) {
			await request(target.base, "/withdraw-consent", { code: target.code, identity: revoked });
			await chrome.storage.local.remove(revocationKey);
			return;
		}
		const permitted = await chrome.permissions.contains({ origins: adapter.origins });
		const tabs = permitted
			? (await chrome.tabs.query({ url: adapter.origins })).filter(
					(t) => t.url && adapter.matches(t.url),
				)
			: [];
		const candidates = [];
		let signedOut = false;
		const seen = new Set();
		for (const tab of tabs.slice(0, 32)) {
			const value = await inTab(tab.id, adapter, adapter.identify, {}, null, item.workspace).catch(
				() => ({ ok: false }),
			);
			if (!value.ok || value.result?.workspace !== item.workspace) {
				if (
					["sign_in_required", "session_expired", "token_expired", "token_revoked"].includes(
						value.error,
					)
				)
					signedOut = true;
				continue;
			}
			const identity = value.result,
				key = JSON.stringify(identity);
			if (seen.has(key)) continue;
			seen.add(key);
			let candidate = entry.identities.get(key);
			if (!candidate || candidate.tabId !== tab.id)
				candidate = {
					id: crypto.randomUUID(),
					revision: crypto.randomUUID(),
					...browser,
					identity,
					tabId: tab.id,
				};
			entry.identities.set(key, candidate);
			candidates.push(candidate);
		}
		for (const key of entry.identities.keys()) if (!seen.has(key)) entry.identities.delete(key);
		await request(target.base, "/review", {
			code: target.code,
			profileId: browser.profileId,
			profileLabel: browser.profileLabel,
			candidates: candidates.map(({ tabId: _tabId, ...c }) => c),
			hint: !permitted
				? "permission_required"
				: candidates.length
					? "discovering"
					: item.sessionRecoveryV1 && !signedOut
						? "discovering"
						: "sign_in_required",
		});
		const decision = await request(target.base, "/decision", {
			code: target.code,
			profileId: browser.profileId,
		});
		// Discovery and remembered consent never open tabs. Only the user's
		// one-shot "Finish signing in" action may create or focus one.
		if (decision.focus && permitted) {
			const url = adapter.openUrl(item.workspace);
			const tabId = candidates[0]?.tabId || tabs[0]?.id;
			const tab = tabId
				? await chrome.tabs.update(tabId, { active: true })
				: url
					? await chrome.tabs.create({ url, active: true })
					: undefined;
			if (tab) await chrome.windows.update(tab.windowId, { focused: true });
		}
		if (!decision.authorization) return;
		const chosen = candidates.find(
			(c) => c.id === decision.candidateId && c.revision === decision.revision,
		);
		if (!chosen) return;
		const check = await inTab(chosen.tabId, adapter, adapter.identify, {}, chosen.identity);
		if (!check.ok || JSON.stringify(check.result) !== JSON.stringify(chosen.identity)) return;
		const approved = await request(target.base, "/pair", {
			code: target.code,
			candidateId: chosen.id,
			authorization: decision.authorization,
			identity: chosen.identity,
		});
		await chrome.storage.session.set({
			[prefix + item.id]: {
				base: target.base,
				provider: item.provider,
				tabId: chosen.tabId,
				identity: chosen.identity,
				...approved,
			},
		});
		discoveries.delete(item.id);
		await badge();
		void pump(item.id);
	} catch {
		/* Expired requests are replaced by Desktop; never replay provider actions. */
	} finally {
		processing.delete(item.id);
	}
}
async function refresh() {
	await Promise.all([...discoveries.values()].map(inspect));
}
function connect() {
	if (port) return;
	try {
		port = chrome.runtime.connectNative("com.laplace.browser");
		port.onMessage.addListener((message) => {
			if (Array.isArray(message.requests)) void accept(message.requests);
		});
		port.onDisconnect.addListener(() => {
			void chrome.runtime.lastError;
			port = undefined;
			clearTimeout(reconnect);
			reconnect = setTimeout(connect, 2000);
		});
		port.postMessage({ method: "watch_pending" });
	} catch {
		port = undefined;
		clearTimeout(reconnect);
		reconnect = setTimeout(connect, 2000);
	}
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
	if (
		sender.id === chrome.runtime.id &&
		sender.url?.split(/[?#]/, 1)[0] === chrome.runtime.getURL("broker.html") &&
		message.action === "broker-connect"
	) {
		void (async () => {
			if (!sender.documentId) throw Error();
			const contexts = await chrome.runtime.getContexts({
				documentIds: [sender.documentId],
				contextTypes: ["TAB"],
			});
			if (contexts.length !== 1 || contexts[0].tabId !== message.tabId) throw Error();
			return connectBroker(message.ticket, contexts[0].tabId);
		})().then(respond, () => respond({ error: "Sign-in handoff failed. Return to Desktop." }));
		return true;
	}
	if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("panel.html"))
		return false;
	void (async () => {
		if (message.action === "status")
			return {
				sessions: (await sessions()).map((s) => ({
					id: s.id,
					label: provider(s.provider).label,
					workspace: s.identity.workspace,
				})),
				connected: !!port,
			};
		if (message.action === "disconnect") {
			await disconnect(message.id, undefined, true);
			return { disconnected: true };
		}
		throw Error("Unknown action.");
	})().then(respond, () => respond({ error: "Unable to update the connection. Check Desktop." }));
	return true;
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
	for (const s of await sessions()) if (s.tabId === tabId) await disconnect(s.id, s.token);
});
chrome.tabs.onUpdated.addListener(() => void refresh());
async function resume() {
	connect();
	for (const s of await sessions()) void pump(s.id);
	await refresh();
}
chrome.alarms.create("laplace-browser", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
	if (a.name === "laplace-browser") void resume();
});
chrome.runtime.onStartup.addListener(() => void resume());
chrome.runtime.onInstalled.addListener(() => void resume());
setInterval(() => void refresh(), 1000);
void resume();
