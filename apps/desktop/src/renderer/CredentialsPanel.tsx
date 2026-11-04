import {
	MAX_CREDENTIAL_BINDINGS,
	type CredentialSettings,
} from "@repo/project-protocol/credentials";
import { ShieldCheck, LockKeyhole, Check, Globe, ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CredentialSnapshot } from "../helper/credentials";
import { credentialMessages, type BrowserChoice } from "../shared/credential-setup";
import type { ClientSnapshot } from "../shared/helper-contracts";
import { invoke } from "./types";

type LoginItem = { id: string; label: string; origins: string[] };
type Step = "connect" | "signIn" | "logins" | "assistants" | "browser" | "overview";
async function request<T = unknown>(method: string, input?: unknown): Promise<T> {
	const result = await invoke<T | { error: { message: string; code: string } }>(method, input);
	if (
		result &&
		typeof result === "object" &&
		"error" in result &&
		result.error &&
		typeof result.error === "object" &&
		"message" in result.error
	)
		throw Object.assign(new Error(String(result.error.message)), { code: result.error.code });
	return result as T;
}
const site = (origin: string) => {
	try {
		return new URL(origin).hostname;
	} catch {
		return origin;
	}
};
export function CredentialsPanel({
	clients,
	addAssistant,
	linkAccount,
	accountLinked = false,
}: {
	clients: ClientSnapshot[];
	addAssistant: () => void;
	linkAccount: () => void;
	accountLinked?: boolean;
}) {
	const [state, setState] = useState<CredentialSnapshot>();
	const [step, setStep] = useState<Step>();
	const [password, setPassword] = useState("");
	const [email, setEmail] = useState("");
	const [region, setRegion] = useState("https://vault.bitwarden.com");
	const [customServer, setCustomServer] = useState("");
	const [code, setCode] = useState("");
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [useApiKey, setUseApiKey] = useState(false);
	const [method, setMethod] = useState("0");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const working = useRef(false);
	const [items, setItems] = useState<LoginItem[]>([]);
	const [itemsLoaded, setItemsLoaded] = useState(false);
	const [query, setQuery] = useState("");
	const [browsers, setBrowsers] = useState<BrowserChoice[]>([]);
	const [searchedBrowsers, setSearchedBrowsers] = useState(false);
	const [advanced, setAdvanced] = useState({ bwPath: "bw", endpoint: "", actions: "[]" });
	const [disconnecting, setDisconnecting] = useState(false);
	const mounted = useRef(true);
	const refresh = async () => {
		const next = await request<CredentialSnapshot>("credentials.status");
		if (mounted.current) setState(next);
		return next;
	};
	useEffect(() => {
		mounted.current = true;
		let running = false;
		const load = async () => {
			if (running) return;
			running = true;
			try {
				const next = await refresh();
				if (mounted.current)
					setStep(
						(current) =>
							current ??
							(next.settings.setupComplete
								? "overview"
								: next.settings.enabled && next.connection.phase === "connected"
									? ["logins", "assistants", "browser"].includes(next.settings.setupStep)
										? next.settings.setupStep
										: "logins"
									: next.settings.managedBitwarden
										? "signIn"
										: "connect"),
					);
			} catch {
				if (mounted.current)
					setMessage("Couldn't reach the local Bitwarden service. Restart Laplace and try again.");
			} finally {
				running = false;
			}
		};
		void load();
		const timer = setInterval(() => void load(), 2000);
		return () => {
			mounted.current = false;
			clearInterval(timer);
		};
	}, []);
	const serializedAdvanced = state
		? JSON.stringify({
				bwPath: state.settings.bwPath,
				endpoint: state.settings.cdpEndpoint,
				actions: JSON.stringify(state.settings.actions, null, 2),
			})
		: "";
	useEffect(() => {
		if (serializedAdvanced) setAdvanced(JSON.parse(serializedAdvanced));
	}, [serializedAdvanced]);
	useEffect(() => {
		if (state?.unlocked && step === "signIn")
			setStep(
				["logins", "assistants", "browser"].includes(state.settings.setupStep)
					? state.settings.setupStep
					: "logins",
			);
		if (!state?.unlocked) {
			setItems([]);
			setItemsLoaded(false);
		}
	}, [state?.unlocked, state?.settings.setupStep, step]);
	useEffect(() => {
		if (step !== "logins" || !state?.unlocked) return;
		let active = true;
		void request<LoginItem[]>("credentials.items")
			.then((result) => {
				if (active) {
					setItems(result);
					setItemsLoaded(true);
				}
			})
			.catch((error) => {
				if (active) setMessage(error instanceof Error ? error.message : credentialMessages.failed);
			});
		return () => {
			active = false;
		};
	}, [step, state?.unlocked]);
	useEffect(() => {
		if (state?.connection.error === "api_key_required") setUseApiKey(true);
	}, [state?.connection.error]);
	const perform = async (work: () => Promise<unknown>) => {
		if (working.current) return;
		working.current = true;
		setBusy(true);
		setMessage("");
		try {
			await work();
			await refresh();
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "signed_out" &&
				state?.settings.managedBitwarden
			)
				setStep("signIn");
			if (mounted.current)
				setMessage(error instanceof Error ? error.message : credentialMessages.failed);
		} finally {
			working.current = false;
			if (mounted.current) setBusy(false);
		}
	};
	const save = async (patch: Partial<CredentialSettings>) => {
		if (!state) return;
		const next = await request<CredentialSnapshot>("credentials.save", {
			settings: { ...state.settings, ...patch },
		});
		if (mounted.current) setState(next);
	};
	const loadItems = () =>
		perform(async () => {
			const result = await request<LoginItem[]>("credentials.items");
			setItems(result);
			setItemsLoaded(true);
		});
	const discover = () =>
		perform(async () => {
			setBrowsers(await request<BrowserChoice[]>("credentials.browsers"));
			setSearchedBrowsers(true);
		});
	if (!state || !step)
		return (
			<section className="credential-setup" aria-label="Bitwarden">
				<p>{message || "Loading Bitwarden…"}</p>
			</section>
		);
	const settings = state.settings;
	const connection = state.connection;
	const signingIn = ["signing_in", "challenge", "preparing"].includes(connection.phase);
	const current = ["connect", "signIn", "logins", "assistants", "browser"].indexOf(step);
	const selectedIds = new Set(settings.bindings.map((b) => b.itemId));
	const allLoginsSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));
	const selectAllLogins = () =>
		perform(async () => {
			const bindings = [...settings.bindings];
			const ids = new Set(selectedIds);
			for (const item of items) {
				if (ids.has(item.id)) continue;
				ids.add(item.id);
				bindings.push({
					id: crypto.randomUUID(),
					itemId: item.id,
					label: item.label,
					origins: item.origins,
				});
			}
			if (bindings.length > MAX_CREDENTIAL_BINDINGS)
				throw new Error(credentialMessages.vault_limit);
			await save({ bindings });
		});
	const visibleItems = [
		...items,
		...settings.bindings
			.filter((b) => !items.some((i) => i.id === b.itemId))
			.map((b) => ({ id: b.itemId, label: b.label, origins: b.origins })),
	].filter((item) =>
		`${item.label} ${item.origins.join(" ")}`.toLowerCase().includes(query.toLowerCase()),
	);
	const accountUrl = `${settings.bitwardenServer.replace(/\/$/, "")}/#/settings/security/security-keys`;
	const unlock = (
		<form
			className="credential-form"
			onSubmit={(e) => {
				e.preventDefault();
				const value = password;
				setPassword("");
				void perform(() => request("credentials.unlock", { password: value }));
			}}
		>
			<label>
				Master password
				<input
					autoComplete="off"
					type="password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
			</label>
			<p className="small muted">
				Unlocks for up to 15 minutes. Your master password is never saved or sent to your assistant.
			</p>
			<button className="primary" disabled={busy || !password}>
				Unlock Bitwarden
			</button>
		</form>
	);
	return (
		<section className="credential-setup stack" aria-label="Bitwarden">
			<div className="credential-heading">
				<div className="credential-mark">
					<ShieldCheck size={24} />
				</div>
				<div>
					<h2>Bitwarden</h2>
					<p className="muted">Let your assistants use the logins you choose.</p>
				</div>
			</div>
			{step !== "overview" && (
				<ol className="credential-steps" aria-label="Connection progress">
					{["Connect", "Sign in", "Logins", "Assistants", "Browser"].map((name, i) => (
						<li
							key={name}
							aria-current={current === i ? "step" : undefined}
							className={i <= current ? "active" : ""}
						>
							<span>{i < current ? <Check size={12} /> : i + 1}</span>
							{name}
						</li>
					))}
				</ol>
			)}
			{message && (
				<p className="credential-notice" role="status">
					{message}
				</p>
			)}
			{connection.error && (
				<p className="credential-notice" role="alert">
					{credentialMessages[connection.error]}
				</p>
			)}
			{step === "connect" && (
				<div className="stack">
					<h3>Connect your Bitwarden account</h3>
					<p>
						Choose which logins an assistant can use. You'll approve requests here in Laplace, and
						passwords stay out of its tool responses.
					</p>
					{settings.enabled && !settings.managedBitwarden && (
						<div className="credential-notice">
							<strong>Your existing connection is still available.</strong>
							<p>
								Keep using it, or switch to guided setup. Switching signs in separately and keeps
								your selected logins.
							</p>
							<button disabled={busy} onClick={() => setStep("logins")}>
								Keep existing connection
							</button>
						</div>
					)}
					<label className="credential-form">
						Where is your account?
						<select value={region} onChange={(e) => setRegion(e.target.value)}>
							<option value="https://vault.bitwarden.com">Bitwarden — United States</option>
							<option value="https://vault.bitwarden.eu">Bitwarden — Europe</option>
							<option value="custom">Self-hosted Bitwarden</option>
						</select>
					</label>
					{region === "custom" && (
						<label className="credential-form">
							Your Bitwarden server
							<input
								type="url"
								placeholder="https://vault.example.com"
								value={customServer}
								onChange={(e) => setCustomServer(e.target.value)}
							/>
						</label>
					)}
					<p className="small muted">
						Laplace will prepare the official Bitwarden component for you. No terminal or extension
						needed.
					</p>
					<div className="row">
						<button
							className="primary"
							disabled={
								busy || connection.phase === "preparing" || (region === "custom" && !customServer)
							}
							onClick={() =>
								void perform(async () => {
									await request("credentials.prepare", {
										server: region === "custom" ? customServer : region,
									});
									setStep("signIn");
								})
							}
						>
							{busy || connection.phase === "preparing"
								? "Preparing Bitwarden…"
								: "Connect Bitwarden"}
						</button>
						{(busy || connection.phase === "preparing") && (
							<button onClick={() => void request("credentials.cancel").then(refresh)}>
								Cancel
							</button>
						)}
					</div>
				</div>
			)}
			{step === "signIn" && (
				<div className="stack">
					<h3>{connection.phase === "challenge" ? "Verify it's you" : "Sign in to Bitwarden"}</h3>
					<p className="small muted">
						Your account is on {site(settings.bitwardenServer)}. Sign-in happens on this computer.
					</p>
					{connection.phase === "challenge" ? (
						<form
							className="credential-form"
							onSubmit={(e) => {
								e.preventDefault();
								const value = code;
								setCode("");
								void perform(() => request("credentials.answer", { value }));
							}}
						>
							{connection.challenge === "method" ? (
								<label>
									Verification method
									<select value={code} onChange={(e) => setCode(e.target.value)} required>
										<option value="">Choose a method…</option>
										{connection.methods?.map((m) => (
											<option key={m}>{m}</option>
										))}
									</select>
								</label>
							) : (
								<label>
									{connection.challenge === "api_secret"
										? "Personal API key secret"
										: connection.challenge === "device_code"
											? "Code sent to your email"
											: "Verification code"}
									<input
										type={connection.challenge === "api_secret" ? "password" : "text"}
										autoComplete={connection.challenge === "api_secret" ? "off" : "one-time-code"}
										value={code}
										onChange={(e) => setCode(e.target.value)}
										required
									/>
								</label>
							)}
							{connection.challenge === "api_secret" && (
								<p className="small">
									Bitwarden requires an extra account check.{" "}
									<a href={accountUrl} target="_blank" rel="noreferrer">
										Open Bitwarden → Security → Keys
									</a>
									, choose View API key, then copy the client_secret here.
								</p>
							)}
							<button className="primary" disabled={busy || !code}>
								Continue
							</button>
						</form>
					) : connection.phase === "signing_in" ? (
						<p role="status">Signing in securely…</p>
					) : connection.phase === "connected" ? (
						unlock
					) : (
						<form
							className="credential-form"
							onSubmit={(e) => {
								e.preventDefault();
								const input = {
									email,
									password,
									method,
									...(useApiKey ? { clientId, clientSecret } : {}),
								};
								setPassword("");
								setClientSecret("");
								void perform(() => request("credentials.signIn", input));
							}}
						>
							<label>
								Email address
								<input
									type="email"
									autoComplete="username"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									required
								/>
							</label>
							<label>
								Master password
								<input
									type="password"
									autoComplete="off"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									required
								/>
							</label>
							{useApiKey && (
								<div className="stack">
									<p className="small">
										In{" "}
										<a href={accountUrl} target="_blank" rel="noreferrer">
											Bitwarden → Security → Keys
										</a>
										, choose View API key. Copy these two values here. Your master password is still
										needed to unlock the vault.
									</p>
									<label>
										Client ID
										<input
											value={clientId}
											onChange={(e) => setClientId(e.target.value)}
											required
										/>
									</label>
									<label>
										Client secret
										<input
											type="password"
											autoComplete="off"
											value={clientSecret}
											onChange={(e) => setClientSecret(e.target.value)}
											required
										/>
									</label>
								</div>
							)}
							<details>
								<summary>Other sign-in options</summary>
								<label>
									Verification method
									<select value={method} onChange={(e) => setMethod(e.target.value)}>
										<option value="0">Authenticator app (default)</option>
										<option value="1">Email</option>
										<option value="3">YubiKey OTP</option>
									</select>
								</label>
								<label className="credential-choice">
									<input
										type="checkbox"
										checked={useApiKey}
										onChange={(e) => setUseApiKey(e.target.checked)}
									/>
									<span>Use a personal API key</span>
								</label>
								<p className="small muted">
									Passkey-only and trusted-device-only accounts aren't supported. Organization
									accounts need a master password.
								</p>
							</details>
							<button
								className="primary"
								disabled={
									busy || !password || !email || (useApiKey && (!clientId || !clientSecret))
								}
							>
								Sign in
							</button>
						</form>
					)}
					<div className="row">
						{signingIn ? (
							<button onClick={() => void perform(() => request("credentials.cancel"))}>
								Cancel sign-in
							</button>
						) : (
							<button onClick={() => setStep("connect")}>
								<ArrowLeft size={14} /> Back
							</button>
						)}
						{connection.error === "unavailable" && (
							<button
								onClick={() =>
									void perform(() =>
										request("credentials.prepare", { server: settings.bitwardenServer }),
									)
								}
							>
								Retry preparation
							</button>
						)}
						{connection.error === "account_mismatch" && (
							<button onClick={() => setStep("logins")}>Manage saved logins</button>
						)}
					</div>
				</div>
			)}
			{step === "logins" && (
				<div className="stack">
					<h3>Which logins can your assistants use?</h3>
					<p>Only the logins you select are available. Every use still needs your approval.</p>
					{!state.unlocked ? (
						<div className="stack">
							{unlock}
							{!!settings.bindings.length && (
								<div className="stack">
									<p className="small muted">
										You can remove saved selections while locked. This never deletes a login from
										Bitwarden.
									</p>
									{settings.bindings.map((binding) => (
										<div className="row" key={binding.id}>
											<span>{binding.label}</span>
											<button
												disabled={busy}
												onClick={() =>
													void perform(() =>
														save({
															bindings: settings.bindings.filter((b) => b.id !== binding.id),
															actions: settings.actions.filter(
																(a) => a.credentialId !== binding.id,
															),
														}),
													)
												}
											>
												Remove {binding.label}
											</button>
										</div>
									))}
								</div>
							)}
							{settings.managedBitwarden && (
								<button onClick={() => setStep("signIn")}>Back to sign in</button>
							)}
						</div>
					) : (
						<>
							<div className="row">
								<input
									aria-label="Search logins"
									type="search"
									placeholder="Search by name or website"
									value={query}
									onChange={(e) => setQuery(e.target.value)}
								/>
								<button disabled={busy} onClick={() => void loadItems()}>
									{itemsLoaded ? "Refresh logins" : "Choose from my vault"}
								</button>
							</div>
							<div className="row">
								<button
									disabled={busy || !itemsLoaded || !items.length || allLoginsSelected}
									onClick={() => void selectAllLogins()}
								>
									{allLoginsSelected
										? "All logins selected"
										: `Select all logins${itemsLoaded ? ` (${items.length})` : ""}`}
								</button>
								<span className="small muted">
									Includes logins outside your search. New logins aren't added automatically.
								</span>
							</div>
							<div className="credential-list">
								{visibleItems.map((item) => (
									<label className="credential-choice" aria-label={item.label} key={item.id}>
										<input
											type="checkbox"
											checked={selectedIds.has(item.id)}
											disabled={
												busy ||
												(!selectedIds.has(item.id) &&
													settings.bindings.length >= MAX_CREDENTIAL_BINDINGS)
											}
											onChange={(e) => {
												const selected = e.target.checked;
												void perform(() =>
													save({
														bindings: selected
															? [
																	...settings.bindings,
																	{
																		id: crypto.randomUUID(),
																		itemId: item.id,
																		label: item.label,
																		origins: item.origins,
																	},
																]
															: settings.bindings.filter((b) => b.itemId !== item.id),
														...(selected
															? {}
															: {
																	actions: settings.actions.filter(
																		(a) =>
																			!settings.bindings.some(
																				(b) => b.itemId === item.id && b.id === a.credentialId,
																			),
																	),
																}),
													}),
												);
											}}
										/>
										<span>
											<strong>{item.label}</strong>
											<small>
												{item.origins.map(site).join(", ") ||
													"No website saved · API and command use only"}
											</small>
										</span>
									</label>
								))}
							</div>
							{itemsLoaded && !visibleItems.length && (
								<p className="small muted">
									No matching logins. Try another search, or add a login in Bitwarden and refresh.
								</p>
							)}
							<p className="small muted">
								{settings.bindings.length} selected · Changes save automatically
							</p>
						</>
					)}
					<div className="row">
						<button
							className="primary"
							disabled={busy}
							onClick={() =>
								void perform(async () => {
									await save({ setupStep: "assistants" });
									setStep("assistants");
								})
							}
						>
							{settings.bindings.length ? "Continue" : "Choose logins later"}
						</button>
						{settings.setupComplete && <button onClick={() => setStep("overview")}>Done</button>}
					</div>
				</div>
			)}
			{step === "assistants" && (
				<div className="stack">
					<h3>Choose your assistants</h3>
					<p>Give access only to assistants you trust. You can change this at any time.</p>
					<div className="credential-list">
						{clients
							.filter((c) => c.enabled)
							.map((client) => (
								<label className="credential-choice" aria-label={client.name} key={client.id}>
									<input
										type="checkbox"
										disabled={busy}
										checked={settings.clients.includes(client.id)}
										onChange={(e) => {
											const allowed = e.target.checked;
											void perform(async () => {
												if (
													allowed &&
													client.allowedLocalTools &&
													!client.allowedLocalTools.includes("local_credentials")
												)
													await request("client.permissions", {
														clientId: client.id,
														tools: [...client.allowedLocalTools, "local_credentials"],
													});
												await save({
													clients: allowed
														? [...settings.clients, client.id]
														: settings.clients.filter((id) => id !== client.id),
												});
											});
										}}
									/>
									<span>
										<strong>{client.name}</strong>
										<small>
											On this computer
											{client.allowedLocalTools &&
											!client.allowedLocalTools.includes("local_credentials")
												? " · Selecting this also enables credential requests"
												: ""}
										</small>
									</span>
								</label>
							))}
					</div>
					{!clients.some((c) => c.enabled) && <p>No local assistants are connected yet.</p>}
					<div>
						<button onClick={addAssistant}>Add an assistant</button>
					</div>
					<label
						className="credential-choice"
						aria-label="Assistants connected through Laplace online"
					>
						<input
							type="checkbox"
							disabled={busy || !accountLinked}
							checked={settings.hosted}
							onChange={(e) => void perform(() => save({ hosted: e.target.checked }))}
						/>
						<span>
							<strong>Assistants connected through Laplace online</strong>
							<small>
								{!accountLinked
									? "Link this computer to your Laplace account first."
									: state.hostedState === "ready"
										? "Connected · Requests arrive here for approval."
										: settings.hosted
											? "Checking connection. If unavailable, check your account link and backend support."
											: "Optional · Laplace must stay open on this computer."}
							</small>
						</span>
					</label>
					{!accountLinked && <button onClick={linkAccount}>Link my Laplace account</button>}
					<div className="row">
						<button onClick={() => setStep("logins")}>
							<ArrowLeft size={14} /> Back
						</button>
						<button
							className="primary"
							disabled={busy}
							onClick={() =>
								void perform(async () => {
									await save({ setupStep: "browser" });
									setStep("browser");
									setBrowsers(await request<BrowserChoice[]>("credentials.browsers"));
									setSearchedBrowsers(true);
								})
							}
						>
							Continue
						</button>
					</div>
				</div>
			)}
			{step === "browser" && (
				<div className="stack">
					<h3>Connect a browser</h3>
					<p>
						Use a compatible browser your assistant already controls, or open a separate browser for
						your assistant. Your usual browser stays unchanged.
					</p>
					{state.browser.available && (
						<div className="credential-notice">
							<strong>
								<Check size={14} /> {state.browser.name ?? "Browser"} available
							</strong>
							<p>Your assistant still needs to attach its browser tools to this session.</p>
							<button
								onClick={() =>
									void perform(async () => {
										await navigator.clipboard.writeText(
											"Use Laplace's local_credentials status tool to find the selected local browser endpoint, then attach your existing browser tools to that session if they support CDP. Use local_credentials for approved Bitwarden fills. If your browser tools cannot attach to a local browser, explain that limitation; do not ask me for passwords or claim you are connected.",
										);
										setMessage("Instructions copied. Paste them into your local assistant's chat.");
									})
								}
							>
								Copy instructions for my assistant
							</button>
							{state.browser.owned && (
								<button
									disabled={busy}
									onClick={() => void perform(() => request("credentials.browserClose"))}
								>
									Close this browser
								</button>
							)}
						</div>
					)}
					<div className="credential-browser-options">
						<div className="stack">
							<h4>Use an existing browser</h4>
							<p className="small muted">
								Compatible local sessions appear here. Most ordinary browser windows don't allow
								this connection.
							</p>
							{browsers
								.filter((b) => b.kind === "running")
								.map((b, index) => (
									<button
										key={b.id}
										disabled={busy}
										onClick={() =>
											void perform(() =>
												request("credentials.browserSelect", { id: b.id, launch: false }),
											)
										}
									>
										<Globe size={15} />
										{b.name} · Session {index + 1}
									</button>
								))}
							{searchedBrowsers && !browsers.some((b) => b.kind === "running") && (
								<p className="small">No compatible sessions found.</p>
							)}
							<button disabled={busy} onClick={() => void discover()}>
								{busy ? "Checking…" : "Find browsers"}
							</button>
						</div>
						<div className="stack">
							<h4>Open a compatible browser</h4>
							<p className="small muted">
								Creates a separate Laplace profile. Your assistant needs browser tools that can
								attach to it.
							</p>
							{browsers
								.filter((b) => b.kind === "installed")
								.map((b) => (
									<button
										key={b.id}
										disabled={busy || state.browser.owned}
										onClick={() =>
											void perform(() =>
												request("credentials.browserSelect", { id: b.id, launch: true }),
											)
										}
									>
										Open {b.name}
									</button>
								))}
							{searchedBrowsers && !browsers.some((b) => b.kind === "installed") && (
								<p className="small">
									Install{" "}
									<a href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">
										Google Chrome
									</a>{" "}
									or{" "}
									<a
										href="https://www.microsoft.com/edge/download"
										target="_blank"
										rel="noreferrer"
									>
										Microsoft Edge
									</a>
									, then choose Find browsers again.
								</p>
							)}
						</div>
					</div>
					<p className="small muted">
						Cloud-only browsers can't connect to this computer. Filled passwords can still be read
						by the website and other browser tools.
					</p>
					<div className="row">
						<button onClick={() => setStep("assistants")}>
							<ArrowLeft size={14} /> Back
						</button>
						<button
							className="primary"
							disabled={busy}
							onClick={() =>
								void perform(async () => {
									await save({ setupComplete: true });
									setStep("overview");
								})
							}
						>
							{state.browser.available ? "Finish setup" : "Set up browser later"}
						</button>
					</div>
				</div>
			)}
			{step === "overview" && (
				<div className="stack">
					<div className="credential-status">
						<span>
							<ShieldCheck size={16} />
							{connection.account ?? "Bitwarden"}
						</span>
						<span>
							<LockKeyhole size={16} />
							{state.unlocked ? "Unlocked · up to 15 minutes" : "Locked"}
						</span>
						<span>
							{settings.bindings.length} {settings.bindings.length === 1 ? "login" : "logins"}{" "}
							selected
						</span>
						<span>
							{settings.clients.length} local{" "}
							{settings.clients.length === 1 ? "assistant" : "assistants"}
							{settings.hosted ? " + online access" : ""}
						</span>
						<span>
							<Globe size={16} />
							{state.browser.available ? "Browser available" : "Browser not connected"}
						</span>
					</div>
					{!state.unlocked && unlock}
					<div className="row">
						{state.unlocked && (
							<button
								disabled={busy}
								onClick={() => void perform(() => request("credentials.lock"))}
							>
								Lock Bitwarden
							</button>
						)}
						<button onClick={() => setStep("logins")}>Manage access</button>
						<button
							onClick={() => {
								setStep("browser");
								void discover();
							}}
						>
							Set up browser
						</button>
						<button className="danger-quiet" onClick={() => setDisconnecting(true)}>
							Disconnect
						</button>
					</div>
					{disconnecting && (
						<div className="credential-notice">
							<p>
								Disconnect Bitwarden from Laplace? This stops access and signs out of Laplace's
								separate Bitwarden session. Your vault and saved login selections remain unchanged.
							</p>
							<div className="row">
								<button
									disabled={busy}
									onClick={() =>
										void perform(async () => {
											await request("credentials.disconnect");
											setDisconnecting(false);
											setStep("connect");
											setPassword("");
											setItems([]);
										})
									}
								>
									Disconnect Bitwarden
								</button>
								<button onClick={() => setDisconnecting(false)}>Keep connected</button>
							</div>
						</div>
					)}
					{!settings.managedBitwarden && (
						<button onClick={() => setStep("connect")}>Switch to guided connection</button>
					)}
				</div>
			)}
			{!!state.pending.length && (
				<div className="stack credential-approvals">
					<h3>Requests awaiting approval</h3>
					{state.pending.map((p) => (
						<div className="stack" key={p.principalId + p.id}>
							<strong>{p.client}</strong>
							<p className="break">{p.summary}</p>
							<div className="row">
								{[
									{ text: "Allow once", allow: true, remember: false },
									{ text: "Allow for 15 minutes", allow: true, remember: true },
									{ text: "Deny", allow: false, remember: false },
								].map((choice) => (
									<button
										key={choice.text}
										disabled={busy}
										onClick={() =>
											void perform(() =>
												request("credentials.approve", {
													principalId: p.principalId,
													id: p.id,
													allow: choice.allow,
													remember: choice.remember,
												}),
											)
										}
									>
										{choice.text}
									</button>
								))}
							</div>
							<p className="small muted">
								Applies only to this assistant and this exact request scope.
							</p>
						</div>
					))}
				</div>
			)}
			<details className="credential-advanced">
				<summary>Advanced settings</summary>
				<div className="stack">
					<p className="small muted">
						For custom installations and configured API or command actions. Saving these settings
						locks the vault.
					</p>
					<label>
						Bitwarden CLI override (existing connections only)
						<input
							disabled={settings.managedBitwarden}
							value={advanced.bwPath}
							onChange={(e) => setAdvanced({ ...advanced, bwPath: e.target.value })}
						/>
					</label>
					<label>
						Browser CDP address
						<input
							value={advanced.endpoint}
							onChange={(e) => setAdvanced({ ...advanced, endpoint: e.target.value })}
							placeholder="http://127.0.0.1:9222"
						/>
					</label>
					<details>
						<summary>API and command actions</summary>
						<p className="small">Only configure trusted commands and destinations.</p>
						{settings.bindings.map((b) => (
							<p className="small" key={b.id}>
								{b.label}: <code>{b.id}</code>
							</p>
						))}
						<label>
							Configured actions JSON
							<textarea
								rows={10}
								value={advanced.actions}
								onChange={(e) => setAdvanced({ ...advanced, actions: e.target.value })}
							/>
						</label>
					</details>
					<button
						disabled={busy}
						onClick={() =>
							void perform(async () => {
								let actions: unknown;
								try {
									actions = JSON.parse(advanced.actions);
								} catch {
									throw new Error(
										"The actions JSON isn't valid. Check its formatting and try again.",
									);
								}
								await request("credentials.configure", {
									settings: {
										...settings,
										bwPath: advanced.bwPath,
										cdpEndpoint: advanced.endpoint,
										actions,
									},
								});
								setMessage("Advanced settings saved. Unlock Bitwarden to continue.");
							})
						}
					>
						Save advanced settings
					</button>
				</div>
			</details>
		</section>
	);
}
