import { useDismissedSetup } from "./useDismissedSetup";
import { Button } from "@repo/ui/components/button";
import { ConnectorPageHeader } from "@repo/ui/components/connector/page-header";
import { SettingsPageView } from "@repo/ui/components/connector/page-views";
import { Cloud, LoaderCircle, LogIn, RefreshCw, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DesktopSnapshot, ServerSnapshot } from "../shared/helper-contracts";
import type { LocalSection, ShellState } from "../shared/shell-contracts";
import { BrokerPanel } from "./BrokerPanel";
import { BrowserApprovalPanel } from "./BrowserApprovalPanel";
import { CredentialsPanel } from "./CredentialsPanel";
import {
	ClientInstallDialog,
	ClientPermissionsDialog,
	ImportDialog,
	InstallDialog,
	Modal,
	ServerForm,
} from "./Dialogs";
import { LocalClientsPage } from "./LocalClientsPage";
import { LocalConnectionsPage } from "./LocalConnectionsPage";
import { LocalSettings, type SetupTarget } from "./LocalPages";
import { LocalSidebar } from "./LocalSidebar";
import {
	invoke,
	type CatalogEntry,
	type CatalogJob,
	type ImportPreview,
	type Perform,
} from "./types";
import { UpdatesPanel } from "./UpdatesPanel";

const initialShell: ShellState = {
	profile: "hosted",
	origin: "https://connect.withlaplace.com",
	mode: "local",
	section: "servers",
	loading: false,
	signIn: "idle",
	browserSignIn: null,
	webShellVersion: null,
	accounts: [],
};
type Dialog =
	| { type: "server"; server?: ServerSnapshot }
	| { type: "server-details"; id: string }
	| { type: "import"; preview: ImportPreview; migration: boolean }
	| { type: "install"; entry: CatalogEntry }
	| { type: "client"; id: string; target?: SetupTarget }
	| { type: "client-permissions"; id: string }
	| {
			type: "confirm";
			title: string;
			message: string;
			action: () => Promise<unknown>;
	  };

function ServerDetails({
	server,
	perform,
	edit,
	remove,
	linked,
}: {
	server: ServerSnapshot;
	perform: Perform;
	edit: () => void;
	remove: () => void;
	linked: boolean;
	signedIn: boolean;
}) {
	const [tools, setTools] = useState(
		server.tools.filter((tool) => tool.localEnabled).map((tool) => tool.name),
	);
	const [dirty, setDirty] = useState(false);
	useEffect(() => {
		if (!dirty) setTools(server.tools.filter((tool) => tool.localEnabled).map((tool) => tool.name));
	}, [server.tools, dirty]);
	return (
		<div className="server-details">
			<div className="stack">
				<div className="section-label">Configuration</div>
				<dl className="metadata">
					<dt>Connection ID</dt>
					<dd className="break">{server.id}</dd>
					<dt>Transport</dt>
					<dd>{server.transport === "stdio" ? "Local command" : "Loopback HTTP"}</dd>
					<dt>Launch</dt>
					<dd>
						<code className="break">{server.command ?? server.url}</code>
					</dd>
					{server.cwd && (
						<>
							<dt>Directory</dt>
							<dd className="break">{server.cwd}</dd>
						</>
					)}
					<dt>Credentials</dt>
					<dd>{server.secretKeys.join(", ") || "None"}</dd>
					<dt>Account access</dt>
					<dd>
						{server.linkMode === "local-only"
							? "Local only"
							: server.linkMode === "blocked"
								? "Awaiting cloud authorization"
								: "Linked to Laplace"}
					</dd>
				</dl>
				<div className="row wrap">
					<button onClick={edit}>
						<Settings2 size={14} />
						Edit configuration
					</button>
					<button
						disabled={!linked}
						onClick={() =>
							void perform(() =>
								invoke("server.access", {
									id: server.id,
									access: { visible: true, remoteEnabled: !server.access?.remoteEnabled },
								}),
							)
						}
					>
						{server.access?.remoteEnabled ? "Keep local" : "Make available remotely"}
					</button>
					<button
						onClick={() =>
							void perform(() =>
								invoke("server.access", {
									id: server.id,
									access: { visible: server.access?.visible === false, remoteEnabled: false },
								}),
							)
						}
					>
						{server.access?.visible === false ? "Show on other devices" : "Hide remotely"}
					</button>
				</div>
				<div className="section-label">Local diagnostics</div>
				<pre className="diagnostics">
					{server.diagnostic.length ? server.diagnostic.join("\n") : "No recent diagnostics."}
				</pre>
				<button className="danger-quiet align-start" onClick={remove}>
					Remove server
				</button>
			</div>
			<div className="stack">
				<div className="row between">
					<div className="section-label">
						Tools <span className="count">{server.tools.length}</span>
					</div>
					{server.tools.length > 0 && (
						<button
							className="text-button"
							onClick={() => {
								setTools(tools.length ? [] : server.tools.map((tool) => tool.name));
								setDirty(true);
							}}
						>
							{tools.length ? "Clear selection" : "Select all"}
						</button>
					)}
				</div>
				{server.linkMode !== "local-only" && (
					<p className="small muted">
						Linked calls also require permission in Laplace. Changing local selections cannot grant
						cloud access.
					</p>
				)}
				<div className="tool-list">
					{server.tools.length ? (
						server.tools.map((tool) => (
							<label className="tool" key={tool.name}>
								<input
									type="checkbox"
									checked={tools.includes(tool.name)}
									onChange={(e) => {
										setTools(
											e.target.checked
												? [...tools, tool.name]
												: tools.filter((name) => name !== tool.name),
										);
										setDirty(true);
									}}
								/>
								<span>
									<code>{tool.name}</code>
									{tool.description && <span className="tool-description">{tool.description}</span>}
								</span>
							</label>
						))
					) : (
						<p className="muted small">Start this server to discover its tools.</p>
					)}
				</div>
				{dirty && (
					<div className="row">
						<button
							className="primary"
							onClick={() =>
								void perform(async () => {
									await invoke("server.permissions", { id: server.id, tools });
									setDirty(false);
								}, "Tool selection saved.")
							}
						>
							Save tool selection
						</button>
						<button onClick={() => setDirty(false)}>Cancel</button>
					</div>
				)}
			</div>
		</div>
	);
}

function CatalogJobs({ jobs, cancel }: { jobs: CatalogJob[]; cancel: (id: string) => void }) {
	const { hidden, dismiss } = useDismissedSetup("laplace:setup-job-dismissals");
	const visible = jobs.filter(
		(job) =>
			!job.notificationDelivered && job.status !== "completed" && !hidden(job.id, job.status),
	);
	if (!visible.length) return null;
	return (
		<details className="setup-activity" open={visible.some((job) => job.status === "running")}>
			<summary>Setup activity ({visible.length})</summary>
			<div className="jobs">
				{visible
					.slice(-4)
					.reverse()
					.map((job) => (
						<div className={`job ${job.status}`} key={job.id}>
							<div className="row">
								<span
									className={`dot ${job.status === "completed" ? "online" : job.status === "failed" ? "needs_attention" : "starting"}`}
								/>
								<strong>{job.connectorName ?? "Connection setup"}</strong>
								<span className="muted small">{job.kind}</span>
							</div>
							<p>{job.message}</p>
							{job.progress !== undefined && job.status === "running" && (
								<progress max={1} value={job.progress} aria-label="Installation progress" />
							)}
							{job.status === "running" ? (
								<button onClick={() => cancel(job.id)}>Cancel</button>
							) : (
								<button
									aria-label={`Dismiss ${job.connectorName ?? "connection"} ${job.kind} notification`}
									onClick={() => dismiss(job.id, job.status)}
								>
									Dismiss
								</button>
							)}
						</div>
					))}
			</div>
		</details>
	);
}

export function App() {
	const contentOnly = new URLSearchParams(window.location.search).get("contentOnly") === "1";
	const [shell, setShell] = useState(initialShell);
	const [approvalRequest, setApprovalRequest] = useState<string>();
	const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
	const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
	const [dialog, setDialog] = useState<Dialog>();
	const [message, setMessage] = useState<{ kind: "error" | "success"; text: string }>();
	const [busy, setBusy] = useState(false);
	const [setupTarget, setSetupTarget] = useState<SetupTarget>("codex");
	const [connectionSearch, setConnectionSearch] = useState("");
	const [connectionView, setConnectionView] = useState("both");
	const [collapsed, setCollapsed] = useState(() => {
		try {
			return localStorage.getItem("laplace:main-sidebar-collapsed") === "true";
		} catch {
			return false;
		}
	});
	const toggleSidebar = () =>
		setCollapsed((value) => {
			try {
				localStorage.setItem("laplace:main-sidebar-collapsed", String(!value));
			} catch {
				/* in-memory preference */
			}
			return !value;
		});

	const manager = useRef<HTMLElement>(null);
	const scrollPositions = useRef<Record<string, number>>({});
	const section = shell.section;
	const linked = !!snapshot?.accountId && snapshot.mode !== "local-only";
	const servers = snapshot?.servers ?? [];
	const jobs = (snapshot?.jobs ?? []) as CatalogJob[];
	const catalogRevision = jobs.map((job) => `${job.id}:${job.status}`).join("|");
	const serverIds = JSON.stringify(servers.map(({ id }) => id).sort());
	const refresh = useCallback(async () => {
		setSnapshot(await invoke<DesktopSnapshot>("status"));
	}, []);
	const perform: Perform = useCallback(
		async (work, success) => {
			setBusy(true);
			setMessage(undefined);
			try {
				await work();
				if (success) setMessage({ kind: "success", text: success });
				await refresh().catch(() => {});
			} catch (error) {
				const text = (error as Error).message.replace(
					/^Error invoking remote method '[^']+': Error: /,
					"",
				);
				setMessage({ kind: "error", text });
				window.dispatchEvent(new CustomEvent("laplace-ui-error", { detail: text }));
			} finally {
				setBusy(false);
			}
		},
		[refresh],
	);
	const show = (next: LocalSection) =>
		perform(async () => {
			setDialog(undefined);
			await invoke("shell.local", { section: next });
		});
	const openLaplace = () => perform(() => invoke("shell.web"));
	const signIn = () => perform(() => invoke("shell.signIn"));
	const confirm = (title: string, text: string, action: () => Promise<unknown>) =>
		setDialog({ type: "confirm", title, message: text, action });
	const removeConnection = (server: ServerSnapshot) =>
		confirm(
			`Delete ${server.name}?`,
			"This removes its desktop configuration and imported credentials. External source files and provider sessions are preserved.",
			() => invoke("server.remove", { id: server.id }),
		);
	useEffect(() => {
		let mounted = true;
		void invoke<ShellState>("shell.status").then((value) => {
			if (mounted) setShell(value);
		});
		void refresh().catch(() => {});
		const off = window.laplaceDesktop.onEvent((event) => {
			if (event.event === "shell") setShell(event.data as ShellState);
			if (event.event === "browser-approval") setApprovalRequest(event.data as string);
			if (event.event === "snapshot") setSnapshot(event.data as DesktopSnapshot);
			if (event.event === "error") setMessage({ kind: "error", text: String(event.data) });
		});
		return () => {
			mounted = false;
			off();
		};
	}, [refresh]);
	useEffect(() => {
		setSnapshot(undefined);
		setCatalog([]);
		setDialog(undefined);
		setConnectionSearch("");
		setConnectionView("both");
		void refresh().catch(() => {});
	}, [shell.profile, refresh]);
	useEffect(() => {
		if (!snapshot?.endpoint) return;
		let current = true;
		void invoke<CatalogEntry[]>("catalog.list")
			.then((entries) => {
				if (current) setCatalog(entries);
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [shell.profile, snapshot?.endpoint, snapshot?.runId, catalogRevision, serverIds]);
	useLayoutEffect(() => {
		const element = manager.current;
		if (!element) return;
		element.scrollTop = scrollPositions.current[section] ?? 0;
	}, [section]);
	const importFile = () =>
		perform(async () => {
			const file = await invoke<string | null>("shell.pickImport");
			if (file)
				setDialog({
					type: "import",
					migration: false,
					preview: await invoke<ImportPreview>("import.preview", { file }),
				});
		});
	const sections: { id: LocalSection; label: string }[] = [
		{ id: "servers", label: "Connections" },
		{ id: "clients", label: "AI clients" },
		{ id: "device", label: "Device" },
		{ id: "updates", label: "Updates" },
		{ id: "credentials", label: "Credentials" },
	];
	if (shell.mode === "web" && !shell.webError)
		return (
			<div className="web-placeholder" role="status">
				<div>
					<LoaderCircle size={24} className="spin" />
					<p>Opening Laplace…</p>
				</div>
			</div>
		);
	return (
		<>
			<div
				className="connector-shell desktop-local-shell"
				data-collapsed={collapsed}
				style={contentOnly ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}
			>
				{!contentOnly && (
					<LocalSidebar
						account={shell.account}
						collapsed={collapsed}
						onToggle={toggleSidebar}
						onOpenLaplace={() => void openLaplace()}
						openLaplaceDisabled={busy || shell.webShellVersion === 0}
						onSignIn={() => void signIn()}
						signingIn={shell.signIn === "waiting"}
						onSignOut={() =>
							confirm(
								"Sign out of Laplace?",
								"Hosted tool grants will be disconnected. Linked servers stay blocked until you reconnect or explicitly unlink.",
								() => invoke("shell.signOut"),
							)
						}
					/>
				)}
				<main
					className="manager connector-page browser-page"
					ref={manager}
					onScroll={(event) => {
						scrollPositions.current[section] = event.currentTarget.scrollTop;
					}}
					aria-busy={busy}
				>
					<BrowserApprovalPanel requestId={approvalRequest} />
					<BrokerPanel />
					{message && (
						<div
							className={`banner ${message.kind}`}
							role={message.kind === "error" ? "alert" : "status"}
						>
							<span>{message.text}</span>
							<button
								className="icon"
								aria-label="Dismiss message"
								onClick={() => setMessage(undefined)}
							>
								<X size={16} />
							</button>
						</div>
					)}
					{shell.helperError && (
						<div className="banner error" role="alert">
							{shell.helperError}
						</div>
					)}
					{shell.signIn === "waiting" && (
						<div className="banner">
							<span>
								<LoaderCircle size={16} className="spin" />
								Finish signing in in your browser.
							</span>
							<button onClick={() => void perform(() => invoke("shell.cancelSignIn"))}>
								Cancel
							</button>
						</div>
					)}
					{(shell.webError || shell.accountError) && (
						<div className="banner error" role="alert">
							<span>
								<Cloud size={16} />
								{shell.webError ?? shell.accountError}
							</span>
							{shell.account ? (
								<button onClick={() => void perform(() => invoke("shell.reload"))}>
									<RefreshCw size={16} />
									Retry
								</button>
							) : (
								<button onClick={() => void signIn()}>
									<LogIn size={16} />
									Sign in
								</button>
							)}
						</div>
					)}
					{shell.account && shell.webShellVersion === 0 && (
						<p className="banner">
							This Laplace server needs an update to open in Desktop. Your local connections remain
							available.
						</p>
					)}
					{!!snapshot?.credentialRequests && section !== "credentials" && (
						<button onClick={() => void show("credentials")}>
							Review {snapshot.credentialRequests} credential request(s)
						</button>
					)}
					<ConnectorPageHeader title="On this device" />
					<SettingsPageView
						navigationLabel="On this device"
						items={sections}
						activeId={section}
						onSelect={(value) => void show(value as LocalSection)}
					>
						<div hidden={section !== "servers"} className="connector-settings-content">
							<CatalogJobs
								jobs={jobs}
								cancel={(jobId) => void perform(() => invoke("catalog.cancel", { jobId }))}
							/>
							<LocalConnectionsPage
								key={shell.profile}
								servers={servers}
								catalog={catalog}
								busy={busy}
								search={connectionSearch}
								onSearch={setConnectionSearch}
								view={connectionView}
								onView={setConnectionView}
								refresh={() => void perform(refresh)}
								add={() => setDialog({ type: "server" })}
								importFile={() => void importFile()}
								details={(server) => setDialog({ type: "server-details", id: server.id })}
								edit={(server) => setDialog({ type: "server", server })}
								remove={removeConnection}
								control={(server, action) =>
									void perform(() => invoke(`server.${action}`, { id: server.id }))
								}
								install={(entry) => setDialog({ type: "install", entry })}
							/>
						</div>
						<div hidden={section !== "clients"} className="connector-settings-content">
							<LocalClientsPage
								key={shell.profile}
								snapshot={snapshot}
								signedIn={!!shell.account}
								target={setupTarget}
								selectTarget={setSetupTarget}
								perform={perform}
								configure={(id, target) => setDialog({ type: "client", id, target })}
								permissions={(id) => setDialog({ type: "client-permissions", id })}
								revoke={(id, name) =>
									confirm(
										`Revoke ${name}?`,
										"Its local connection and hosted grant will stop working. Other AI clients remain connected.",
										() => invoke("client.revoke", { clientId: id }),
									)
								}
							/>
						</div>
						{section === "updates" && (
							<div className="space-y-4">
								<UpdatesPanel update={shell.updates} perform={perform} />
								<Button
									variant="outline"
									onClick={() =>
										void perform(() =>
											shell.account
												? invoke("shell.web")
												: invoke("shell.local", { section: "servers" }),
										)
									}
								>
									Not now
								</Button>
							</div>
						)}
						{section === "device" && (
							<LocalSettings
								shell={shell}
								snapshot={snapshot}
								perform={perform}
								changeProfile={(profile) =>
									void perform(() => invoke("shell.profile", { profile }))
								}
								unlink={() =>
									confirm(
										"Unlink this desktop installation?",
										"Servers and provider sessions remain on this computer. Existing tool restrictions are retained.",
										() => invoke("link.unlink"),
									)
								}
							/>
						)}
						{section === "credentials" && (
							<CredentialsPanel
								key={shell.profile}
								clients={snapshot?.clients ?? []}
								accountLinked={snapshot?.mode === "linked"}
								addAssistant={() => void show("clients")}
								linkAccount={() => void show("device")}
							/>
						)}
					</SettingsPageView>
				</main>
			</div>
			{dialog?.type === "server-details" &&
				snapshot?.servers.find((server) => server.id === dialog.id) &&
				(() => {
					const server = snapshot.servers.find((server) => server.id === dialog.id)!;
					return (
						<Modal title={server.name} close={() => setDialog(undefined)}>
							<div className="dialog-body stack">
								<div className="row">
									<button
										onClick={() =>
											void perform(() =>
												invoke(server.enabled ? "server.stop" : "server.start", { id: server.id }),
											)
										}
									>
										{server.enabled ? "Stop" : "Start"}
									</button>
									<button
										onClick={() => void perform(() => invoke("server.restart", { id: server.id }))}
									>
										Restart
									</button>
								</div>
								{catalog.some((entry) => entry.installed && entry.serverId === server.id) && (
									<div className="row">
										<button
											onClick={() =>
												void perform(() => invoke("catalog.authenticate", { id: server.id }))
											}
										>
											Authenticate
										</button>
										<button
											onClick={() =>
												void perform(() => invoke("catalog.verify", { id: server.id }))
											}
										>
											Verify connection
										</button>
									</div>
								)}
								<ServerDetails
									server={server}
									perform={perform}
									linked={linked}
									signedIn={!!shell.account}
									edit={() => setDialog({ type: "server", server })}
									remove={() => removeConnection(server)}
								/>
							</div>
						</Modal>
					);
				})()}

			{dialog?.type === "server" && (
				<ServerForm server={dialog.server} perform={perform} close={() => setDialog(undefined)} />
			)}
			{dialog?.type === "import" && (
				<ImportDialog
					preview={dialog.preview}
					migration={dialog.migration}
					perform={perform}
					close={() => setDialog(undefined)}
				/>
			)}
			{dialog?.type === "install" && (
				<InstallDialog entry={dialog.entry} perform={perform} close={() => setDialog(undefined)} />
			)}
			{dialog?.type === "client" && (
				<ClientInstallDialog
					clientId={dialog.id}
					initialKind={dialog.target}
					perform={perform}
					close={() => setDialog(undefined)}
				/>
			)}
			{dialog?.type === "client-permissions" &&
				snapshot?.clients.some((client) => client.id === dialog.id) && (
					<ClientPermissionsDialog
						client={snapshot.clients.find((client) => client.id === dialog.id)!}
						tools={snapshot.localTools}
						perform={perform}
						close={() => setDialog(undefined)}
					/>
				)}
			{dialog?.type === "confirm" && (
				<Modal title={dialog.title} close={() => setDialog(undefined)}>
					<div className="dialog-body stack">
						<p>{dialog.message}</p>
						<div className="dialog-actions">
							<button onClick={() => setDialog(undefined)}>Cancel</button>
							<button
								className="primary"
								onClick={() =>
									void perform(async () => {
										await dialog.action();
										setDialog(undefined);
									})
								}
							>
								Confirm
							</button>
						</div>
					</div>
				</Modal>
			)}
		</>
	);
}
