import { X, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ClientSnapshot, ServerSnapshot } from "../shared/helper-contracts";
import {
	invoke,
	type CatalogEntry,
	type ImportPreview,
	type Perform,
	type RegistrationPreview,
} from "./types";

export function Modal({
	title,
	children,
	close,
}: {
	title: string;
	children: ReactNode;
	close: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const [error, setError] = useState<string>();
	useEffect(() => {
		const previous = document.activeElement;
		ref.current?.showModal();
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	useEffect(() => {
		const listener = (event: Event) => setError((event as CustomEvent<string>).detail);
		window.addEventListener("laplace-ui-error", listener);
		return () => window.removeEventListener("laplace-ui-error", listener);
	}, []);
	return (
		<dialog
			ref={ref}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
		>
			<div className="dialog-header">
				<h2>{title}</h2>
				<button className="icon" aria-label="Close dialog" onClick={close}>
					<X size={18} />
				</button>
			</div>
			{error && (
				<div className="dialog-body">
					<p className="danger-text" role="alert">
						{error}
					</p>
				</div>
			)}
			{children}
		</dialog>
	);
}

function parseRecord(text: string): Record<string, string> {
	const result: unknown = JSON.parse(text || "{}");
	if (
		!result ||
		typeof result !== "object" ||
		Array.isArray(result) ||
		Object.values(result).some((v) => typeof v !== "string")
	)
		throw new Error("Credentials must be a JSON object of string values.");
	return result as Record<string, string>;
}

export function ServerForm({
	server,
	perform,
	close,
}: {
	server?: ServerSnapshot;
	perform: Perform;
	close: () => void;
}) {
	const [id, setId] = useState(server?.id ?? "");
	const [name, setName] = useState(server?.name ?? "");
	const [transport, setTransport] = useState(server?.transport ?? "stdio");
	const [command, setCommand] = useState(server?.command ?? "node");
	const [args, setArgs] = useState(server ? "" : "[]");
	const [cwd, setCwd] = useState(server?.cwd ?? "");
	const [url, setUrl] = useState(server ? "" : "http://127.0.0.1:8765/mcp");
	const [credentials, setCredentials] = useState("");
	const [enabled, setEnabled] = useState(server?.enabled ?? false);
	const [review, setReview] = useState<Record<string, unknown>>();
	const [launch, setLaunch] = useState<ImportPreview["entries"][number]>();
	const prepare = () => {
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
			throw new Error("Use a server ID with letters, numbers, hyphens, or underscores.");
		if (!name.trim()) throw new Error("Enter a server name.");
		const value: Record<string, unknown> = { id, name: name.trim(), transport, enabled };
		if (transport === "stdio") {
			value.command = command;
			if (cwd) value.cwd = cwd;
			if (args) {
				const parsed: unknown = JSON.parse(args);
				if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
					throw new Error("Arguments must be a JSON array of strings.");
				value.args = parsed;
			}
			if (credentials) value.env = parseRecord(credentials);
		} else {
			if (url) value.url = url;
			if (credentials) value.headers = parseRecord(credentials);
		}
		return value;
	};
	return (
		<Modal title={server ? `Edit ${server.name}` : "Add a local MCP"} close={close}>
			{review ? (
				<div className="dialog-body stack">
					<p>
						Review this local launch configuration before saving. Credentials are encrypted on this
						computer.
					</p>
					<dl className="review">
						<dt>Name</dt>
						<dd>{String(review.name)}</dd>
						<dt>Transport</dt>
						<dd>{transport}</dd>
						<dt>{transport === "stdio" ? "Executable" : "URL"}</dt>
						<dd>
							<code>
								{launch?.resolvedCommand ??
									launch?.url ??
									(transport === "stdio" ? command : url || "Preserve existing URL")}
							</code>
						</dd>
						<dt>Arguments</dt>
						<dd>{launch?.resolvedArgs?.join(" ") || args || "Preserve existing arguments"}</dd>
						<dt>Directory</dt>
						<dd>{(launch?.resolvedDirectory ?? cwd) || "Managed server directory"}</dd>
						<dt>Credential keys</dt>
						<dd>
							{credentials
								? Object.keys(parseRecord(credentials)).join(", ") || "None"
								: server
									? "Preserve existing values"
									: "None"}
						</dd>
						<dt>After saving</dt>
						<dd>{enabled ? "Start server" : "Keep stopped"}</dd>
					</dl>
					<div className="dialog-actions">
						<button onClick={() => setReview(undefined)}>Back</button>
						<button
							className="primary"
							onClick={() =>
								void perform(async () => {
									await invoke(
										server ? "server.update" : "server.add",
										server ? { id: server.id, config: review } : { config: review },
									);
									close();
								}, "Server saved.")
							}
						>
							{server ? "Save changes" : "Add server"}
						</button>
					</div>
				</div>
			) : (
				<form
					className="dialog-body stack"
					onSubmit={(event) => {
						event.preventDefault();
						void perform(async () => {
							const config = prepare();
							const resolved = await invoke<ImportPreview["entries"][number]>("server.preview", {
								...(server ? { id: server.id } : {}),
								config,
							});
							if (resolved.error) throw new Error(resolved.error);
							setLaunch(resolved);
							setReview(config);
						});
					}}
				>
					<div className="two-col">
						<label>
							Name
							<input
								required
								value={name}
								onChange={(e) => {
									setName(e.target.value);
									if (!server && (!id || id === name.toLowerCase().replace(/[^a-z0-9_-]/g, "-")))
										setId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"));
								}}
								placeholder="My connector"
							/>
						</label>
						<label>
							Server ID
							<input
								required
								value={id}
								disabled={!!server}
								onChange={(e) => setId(e.target.value)}
							/>
						</label>
					</div>
					<label>
						Transport
						<select
							value={transport}
							disabled={!!server}
							onChange={(e) => setTransport(e.target.value as "stdio" | "http")}
						>
							<option value="stdio">Local command (stdio)</option>
							<option value="http">Loopback HTTP</option>
						</select>
					</label>
					{transport === "stdio" ? (
						<>
							<label>
								Executable
								<input
									required
									value={command}
									onChange={(e) => setCommand(e.target.value)}
									placeholder="node, npx, uv, uvx, or an executable path"
								/>
							</label>
							<label>
								Arguments · JSON array
								<textarea
									rows={3}
									value={args}
									onChange={(e) => setArgs(e.target.value)}
									placeholder={
										server
											? "Leave blank to preserve existing arguments"
											: '["/absolute/path/server.mjs"]'
									}
									spellCheck={false}
								/>
							</label>
							<label>
								Working directory
								<div className="input-action">
									<input
										value={cwd}
										onChange={(e) => setCwd(e.target.value)}
										placeholder="Optional absolute directory"
									/>
									<button
										type="button"
										aria-label="Choose working directory"
										onClick={() =>
											void perform(async () => {
												const directory = await invoke<string | null>("shell.pickDirectory");
												if (directory) setCwd(directory);
											})
										}
									>
										<FolderOpen size={16} />
									</button>
								</div>
							</label>
						</>
					) : (
						<label>
							Server URL
							<input
								required={!server}
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder={server ? "Leave blank to preserve the full existing URL" : undefined}
							/>
							<span className="hint">
								Use http://127.0.0.1 or http://[::1]. Start HTTP servers separately.
							</span>
						</label>
					)}
					<label>
						{transport === "stdio" ? "Environment" : "Headers"} · JSON object
						<textarea
							className="credentials"
							rows={3}
							autoComplete="off"
							value={credentials}
							onChange={(e) => setCredentials(e.target.value)}
							placeholder={server ? "Leave blank to preserve credentials" : '{"API_TOKEN": "…"}'}
							spellCheck={false}
						/>
						<span className="hint">
							Values stay in your OS keychain.{" "}
							{server?.secretKeys.length ? `Existing keys: ${server.secretKeys.join(", ")}.` : ""}
						</span>
					</label>
					<label className="check">
						<input
							type="checkbox"
							checked={enabled}
							onChange={(e) => setEnabled(e.target.checked)}
						/>
						Start the server after saving
					</label>
					<div className="dialog-actions">
						<button type="button" onClick={close}>
							Cancel
						</button>
						<button className="primary" type="submit">
							Review configuration
						</button>
					</div>
				</form>
			)}
		</Modal>
	);
}

export function ImportDialog({
	preview,
	migration,
	perform,
	close,
}: {
	preview: ImportPreview;
	migration: boolean;
	perform: Perform;
	close: () => void;
}) {
	const [selected, setSelected] = useState<string[]>([]);
	return (
		<Modal
			title={migration ? "Migrate from Laplace Local" : "Import MCP configuration"}
			close={close}
		>
			<div className="dialog-body stack">
				<p className="muted break">{preview.source}</p>
				<p>
					{preview.notice ??
						"Select only the servers you want to import. Existing Laplace entries cannot be imported into themselves."}
				</p>
				{preview.entries.length === 0 && <p className="muted">No local servers were found.</p>}
				{preview.entries.map((entry) => (
					<div className="import-entry" key={entry.id}>
						<label className="check">
							<input
								type="checkbox"
								disabled={!!entry.error}
								checked={selected.includes(entry.id)}
								onChange={(e) =>
									setSelected(
										e.target.checked
											? [...selected, entry.id]
											: selected.filter((id) => id !== entry.id),
									)
								}
							/>
							<strong>{entry.name}</strong>
						</label>
						{entry.error ? (
							<p className="danger-text">{entry.error}</p>
						) : (
							<div className="small muted">
								<code className="break">{entry.resolvedCommand ?? entry.command ?? entry.url}</code>
								<p>
									{(entry.resolvedArgs ?? entry.args)?.join(" ") ??
										`${entry.argumentCount ?? 0} arguments`}{" "}
									· {entry.enabled ? "Starts after import" : "Imports stopped"}
								</p>
								{(entry.resolvedDirectory ?? entry.cwd) && (
									<p className="break">Directory: {entry.resolvedDirectory ?? entry.cwd}</p>
								)}
								<p>Credential keys: {entry.secretKeys?.join(", ") || "None"}</p>
							</div>
						)}
					</div>
				))}
				{migration && (
					<p className="notice">
						Stop the old wrapper and restart AI clients before enabling migrated servers. Existing
						provider sessions are preserved.
					</p>
				)}
				<div className="dialog-actions">
					<button onClick={close}>Cancel</button>
					<button
						className="primary"
						disabled={!selected.length}
						onClick={() =>
							void perform(async () => {
								await invoke(
									migration ? "migration.apply" : "import.apply",
									migration
										? { root: preview.source, selected }
										: { file: preview.source, selected, fingerprint: preview.fingerprint },
								);
								close();
							}, "Selected servers imported.")
						}
					>
						Import {selected.length || "selected"}
					</button>
				</div>
			</div>
		</Modal>
	);
}

export function InstallDialog({
	entry,
	perform,
	close,
}: {
	entry: CatalogEntry;
	perform: Perform;
	close: () => void;
}) {
	const [values, setValues] = useState(
		Object.fromEntries(entry.fields.map((field) => [field.key, field.default])),
	);
	return (
		<Modal title={`Install ${entry.name}`} close={close}>
			<form
				className="dialog-body stack"
				onSubmit={(event) => {
					event.preventDefault();
					void perform(async () => {
						await invoke("catalog.install", { catalogId: entry.id, configuration: values });
						close();
					});
				}}
			>
				<p>{entry.description}</p>
				<p className="small muted">
					Version {entry.version}. Installs a verified bundle into this profile. Provider sign-in
					follows installation.
				</p>
				{entry.fields.map((field) => (
					<label key={field.key}>
						{field.label}
						{field.type === "select" ? (
							<select
								value={values[field.key]}
								onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
							>
								{field.options?.map((option) => (
									<option key={option} value={option}>
										{option || "Automatic"}
									</option>
								))}
							</select>
						) : (
							<div className="input-action">
								<input
									required={field.required}
									type={field.type === "url" ? "url" : "text"}
									value={values[field.key]}
									onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
								/>
								{field.type === "directory" && (
									<button
										type="button"
										aria-label={`Choose ${field.label}`}
										onClick={() =>
											void perform(async () => {
												const value = await invoke<string | null>("shell.pickDirectory");
												if (value) setValues({ ...values, [field.key]: value });
											})
										}
									>
										<FolderOpen size={16} />
									</button>
								)}
							</div>
						)}
					</label>
				))}
				<div className="notice">
					Authentication opens the connector’s dedicated browser. Complete sign-in, MFA, and any
					keychain prompts yourself. Setup verification runs the connector’s documented login and
					read checks locally.
				</div>
				<div className="dialog-actions">
					<button type="button" onClick={close}>
						Cancel
					</button>
					<button type="submit" className="primary">
						Install {entry.name}
					</button>
				</div>
			</form>
		</Modal>
	);
}

export function ClientInstallDialog({
	clientId,
	initialKind = "codex",
	perform,
	close,
}: {
	clientId: string;
	initialKind?: string;
	perform: Perform;
	close: () => void;
}) {
	const [kind, setKind] = useState(initialKind);
	const [file, setFile] = useState("");
	const [preview, setPreview] = useState<RegistrationPreview>();
	const [remove, setRemove] = useState<Array<"laplace" | "laplace-local">>([]);
	return (
		<Modal title="Connect an AI client" close={close}>
			<div className="dialog-body stack">
				{!preview ? (
					<>
						<label>
							AI client
							<select value={kind} onChange={(e) => setKind(e.target.value)}>
								<option value="codex">Codex</option>
								<option value="claude-code">Claude Code</option>
								<option value="claude-desktop">Claude Desktop</option>
								<option value="other">Other stdio client</option>
							</select>
						</label>
						{kind !== "other" && (
							<>
								<label>
									Configuration file
									<div className="input-action">
										<input
											value={file}
											onChange={(e) => setFile(e.target.value)}
											placeholder={
												kind === "claude-code"
													? "Choose your project’s .mcp.json"
													: "Use the standard user configuration"
											}
										/>
										<button
											aria-label="Choose client configuration"
											onClick={() =>
												void perform(async () => {
													const path = await invoke<string | null>("shell.pickImport");
													if (path) setFile(path);
												})
											}
										>
											<FolderOpen size={16} />
										</button>
									</div>
								</label>
								<p className="muted">
									Preview the change before installation. A backup preserves your current
									configuration.
								</p>
							</>
						)}
						<div className="dialog-actions">
							<button onClick={close}>Cancel</button>
							<button
								className="primary"
								onClick={() =>
									void perform(async () =>
										setPreview(
											await invoke<RegistrationPreview>("client.preview-install", {
												clientId,
												client: kind,
												...(file && kind !== "other" ? { configPath: file } : {}),
											}),
										),
									)
								}
							>
								{kind === "other" ? "Show configuration" : "Preview connection"}
							</button>
						</div>
					</>
				) : (
					<>
						{kind !== "other" && (
							<>
								<p className="break">{preview.file}</p>
								<p>{preview.instructions}</p>
							</>
						)}
						<label>
							Configuration for other stdio clients
							<textarea
								rows={6}
								readOnly
								value={JSON.stringify(
									{ mcpServers: { [preview.entryName]: preview.entry } },
									null,
									2,
								)}
								spellCheck={false}
							/>
						</label>
						<button
							onClick={() =>
								void perform(
									async () =>
										navigator.clipboard.writeText(
											JSON.stringify(
												{ mcpServers: { [preview.entryName]: preview.entry } },
												null,
												2,
											),
										),
									"Configuration copied.",
								)
							}
						>
							Copy configuration
						</button>
						{kind !== "other" && preview.conflict && (
							<p className="notice">An existing Laplace Desktop entry will be replaced.</p>
						)}
						{kind !== "other" && preview.legacyEntries.length > 0 && (
							<fieldset>
								<legend>Legacy entries to replace</legend>
								<p className="small muted">
									Select the remote entry only after connecting hosted tools for this AI client, to
									avoid losing access.
								</p>
								{preview.legacyEntries.map((name) => (
									<label className="check" key={name}>
										<input
											type="checkbox"
											checked={remove.includes(name)}
											onChange={(e) =>
												setRemove(
													e.target.checked
														? [...remove, name]
														: remove.filter((value) => value !== name),
												)
											}
										/>
										{name}
									</label>
								))}
							</fieldset>
						)}
						<div className="dialog-actions">
							<button onClick={() => setPreview(undefined)}>Back</button>
							{kind !== "other" && (
								<button
									className="primary"
									onClick={() =>
										void perform(async () => {
											await invoke("client.install", {
												clientId,
												client: kind,
												configPath: preview.file,
												replace: preview.conflict,
												removeLegacy: remove,
												fingerprint: preview.fingerprint,
											});
											close();
										}, "Connection installed. Restart your AI client.")
									}
								>
									Install connection
								</button>
							)}
						</div>
					</>
				)}
			</div>
		</Modal>
	);
}

export function ClientPermissionsDialog({
	client,
	tools,
	perform,
	close,
}: {
	client: ClientSnapshot;
	tools: Array<{ name: string; title: string }>;
	perform: Perform;
	close: () => void;
}) {
	const [all, setAll] = useState(client.allowedLocalTools === undefined);
	const [selected, setSelected] = useState(
		client.allowedLocalTools?.filter((name) => tools.some((tool) => tool.name === name)) ??
			tools.map((tool) => tool.name),
	);
	return (
		<Modal title={`Local tools for ${client.name}`} close={close}>
			<div className="dialog-body stack">
				<p>
					Choose which local tools this AI client can access. Server enablement and linked account
					permissions still apply. Hosted tools follow this client's separate Laplace grant.
				</p>
				<label className="check">
					<input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
					All enabled local tools, including tools added later
				</label>
				{!all && (
					<div className="tool-list">
						{tools.length ? (
							tools.map((tool) => (
								<label className="tool" key={tool.name}>
									<input
										type="checkbox"
										checked={selected.includes(tool.name)}
										onChange={(event) =>
											setSelected(
												event.target.checked
													? [...selected, tool.name]
													: selected.filter((name) => name !== tool.name),
											)
										}
									/>
									<span>
										{tool.title}
										<code className="tool-description">{tool.name}</code>
									</span>
								</label>
							))
						) : (
							<p className="muted">
								Start a server to discover its tools. Saving an empty selection blocks all local
								tools for this client.
							</p>
						)}
					</div>
				)}
				<div className="dialog-actions">
					<button onClick={close}>Cancel</button>
					<button
						className="primary"
						onClick={() =>
							void perform(async () => {
								await invoke("client.permissions", {
									clientId: client.id,
									tools: all ? null : selected,
								});
								close();
							}, "Client tool access saved.")
						}
					>
						Save access
					</button>
				</div>
			</div>
		</Modal>
	);
}
