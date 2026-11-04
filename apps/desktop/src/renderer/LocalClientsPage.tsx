import { Button } from "@repo/ui/components/button";
import { useRef, useState } from "react";

import { assistantNames, type AssistantSetup } from "../shared/assistant-setup";
import type { DesktopSnapshot } from "../shared/helper-contracts";
import { LocalSetup, type SetupTarget } from "./LocalPages";
import { invoke, type Perform } from "./types";

export function LocalClientsPage({
	snapshot,
	signedIn,
	target,
	selectTarget,
	perform,
	configure,
	permissions,
	revoke,
}: {
	snapshot?: DesktopSnapshot;
	signedIn: boolean;
	target: SetupTarget;
	selectTarget: (value: SetupTarget) => void;
	perform: Perform;
	configure: (id: string, target: SetupTarget) => void;
	permissions: (id: string) => void;
	revoke: (id: string, name: string) => void;
}) {
	const [name, setName] = useState("");
	const [selected, setSelected] = useState("");
	const [busy, setBusy] = useState(false);
	const working = useRef(false);
	const panel = useRef<HTMLDivElement>(null);
	const [prompt, setPrompt] = useState("");
	const [message, setMessage] = useState("");
	const [registered, setRegistered] = useState<string>();
	const enabled = snapshot?.clients.filter((client) => client.enabled) ?? [];
	const assistantName = assistantNames[target];
	const existing =
		selected === "new"
			? undefined
			: enabled.find((client) =>
					selected ? client.id === selected : client.name === assistantName,
				);
	const reset = () => {
		setPrompt("");
		setMessage("");
	};
	const setup = async (action: "instructions" | "open") => {
		if (working.current) return;
		working.current = true;
		setBusy(true);
		try {
			await perform(async () => {
				let id = existing?.id ?? (selected && selected !== "new" ? selected : undefined);
				if (!id) {
					const client = await invoke<{ id: string }>("client.register", {
						name: name.trim() || assistantName,
					});
					id = client.id;
					setSelected(id);
					setRegistered(id);
				}
				const result = await invoke<AssistantSetup>("shell.assistantSetup", {
					clientId: id,
					target,
					action: "instructions",
				});
				setPrompt(result.prompt);
				let copied = false;
				try {
					await navigator.clipboard.writeText(result.prompt);
					copied = true;
				} catch {
					/* Show selectable instructions. */
				}
				if (action === "instructions") {
					setMessage(
						copied
							? "Instructions copied. Paste them into your assistant and send the message to begin setup."
							: "Clipboard unavailable. Select and copy the instructions below, then paste them into your assistant.",
					);
					return;
				}
				let opened = false;
				try {
					const launch = await invoke<AssistantSetup>("shell.assistantSetup", {
						clientId: id,
						target,
						action: "open",
					});
					opened = launch.opened;
				} catch {
					/* Preserve the prepared prompt if launch fails. */
				}
				setMessage(
					opened
						? `Opening ${assistantName} with a setup draft. Review and send it there. If no draft appears, ${copied ? "paste the copied instructions" : "copy the instructions below"}. Your assistant still needs to complete and verify the connection.`
						: `Couldn’t open ${assistantName}. Open it yourself and ${copied ? "paste the copied instructions" : "copy the instructions below"}. For CLI use, paste into a running agent session.`,
				);
			});
		} finally {
			working.current = false;
			setBusy(false);
		}
	};
	const connectDirectly = async () => {
		if (!["codex", "claude-code", "claude-desktop"].includes(target) || working.current) return;
		working.current = true;
		setBusy(true);
		try {
			await perform(async () => {
				let configPath: string | undefined;
				if (target === "claude-code") {
					const directory = await invoke<string | null>("shell.pickDirectory");
					if (!directory) return;
					configPath = `${directory}/.mcp.json`;
				}
				const registration =
					existing ??
					(await invoke<{ id: string }>("client.register", { name: name.trim() || assistantName }));
				const preview = await invoke<{ fingerprint: string; conflict: boolean }>(
					"client.preview-install",
					{ clientId: registration.id, client: target, configPath },
				);
				if (preview.conflict) {
					setMessage("An existing registration needs review in Advanced setup before replacement.");
					return;
				}
				await invoke("client.install", {
					clientId: registration.id,
					client: target,
					configPath,
					fingerprint: preview.fingerprint,
				});
				setSelected(registration.id);
				setMessage(
					"Connected and tool discovery verified. Reload your agent's MCP connections to use Desktop tools.",
				);
			});
		} finally {
			working.current = false;
			setBusy(false);
		}
	};
	return (
		<div className="mcp-howto-grid" ref={panel}>
			<LocalSetup
				target={target}
				selectTarget={(value) => {
					if (working.current) return;
					selectTarget(value);
					setSelected("");
					setName("");
					reset();
				}}
			>
				<div className="space-y-3 mt-4 max-w-xl">
					{enabled.length > 0 && (
						<label className="stack text-sm">
							Connection to use
							<select
								aria-label="Connection to use"
								disabled={busy}
								value={selected || existing?.id || "new"}
								onChange={(event) => {
									setSelected(event.target.value);
									reset();
								}}
							>
								<option value="new">New {assistantName} connection</option>
								{enabled.map((client) => (
									<option key={client.id} value={client.id}>
										{client.name}
									</option>
								))}
							</select>
						</label>
					)}
					<div className="standard-setup-actions">
						{target !== "other" && (
							<Button
								variant="primary"
								disabled={busy || !snapshot}
								onClick={() => void setup("open")}
							>
								{busy ? "Preparing setup…" : `Send setup to ${assistantName}`}
							</Button>
						)}
						{["codex", "claude-code", "claude-desktop"].includes(target) && (
							<Button disabled={busy || !snapshot} onClick={() => void connectDirectly()}>
								Connect {assistantName}
							</Button>
						)}
						<Button
							variant={target === "other" ? "primary" : "outline"}
							disabled={busy || !snapshot}
							onClick={() => void setup("instructions")}
						>
							Copy setup instructions
						</Button>
					</div>
					<p className="text-sm text-muted-foreground">
						Using Codex CLI or Claude Code in a terminal? Copy the instructions into your agent’s
						chat.
					</p>
					{target === "claude-desktop" && (
						<p className="text-sm text-muted-foreground">
							If Claude cannot edit local files, use Advanced below to let Laplace install the
							connection.
						</p>
					)}
					{message && (
						<p role="status" className="notice">
							{message}
						</p>
					)}
					{prompt && (
						<details>
							<summary>View setup instructions</summary>
							<textarea aria-label="Setup instructions" readOnly value={prompt} rows={10} />
						</details>
					)}
					<details>
						<summary>Advanced: manual setup</summary>
						<p className="text-sm text-muted-foreground">
							Preview and install the configuration yourself, or copy it for another MCP client.
						</p>
						{!existing && (
							<label className="stack">
								Assistant name (optional)
								<input
									value={name}
									disabled={busy}
									maxLength={80}
									placeholder={assistantName}
									onChange={(event) => setName(event.target.value)}
								/>
							</label>
						)}
						<Button
							variant="outline"
							disabled={busy || !snapshot}
							onClick={() => {
								if (working.current) return;
								working.current = true;
								setBusy(true);
								void perform(async () => {
									let id = existing?.id ?? (selected && selected !== "new" ? selected : undefined);
									if (!id) {
										const client = await invoke<{ id: string }>("client.register", {
											name: name.trim() || assistantName,
										});
										id = client.id;
										setSelected(id);
										setRegistered(id);
									}
									configure(id, target);
								}).finally(() => {
									working.current = false;
									setBusy(false);
								});
							}}
						>
							Configure manually
						</Button>
					</details>
				</div>
			</LocalSetup>
			<section className="connector-section" aria-labelledby="registered-clients">
				<h2 id="registered-clients" className="connector-section-heading">
					Registered assistants
				</h2>
				{!snapshot?.clients.length && (
					<p className="text-sm text-muted-foreground">No assistants added yet.</p>
				)}
				<div className="home-client-groups">
					{snapshot?.clients.map((client) => (
						<details
							key={client.id}
							className="home-client-group connector-surface p-4"
							open={client.id === registered}
						>
							<summary className="home-client-group-heading">
								<span className="text-sm font-medium">{client.name}</span>
								<span className="home-connection-status home-oauth-status">
									{client.enabled ? "Local access enabled" : "Revoked"}
								</span>
							</summary>
							{signedIn && (
								<p className="text-xs text-muted-foreground">
									Hosted tools: {client.hosted.replace("needs-auth", "sign-in required")}
								</p>
							)}
							{signedIn && client.error && (
								<p className="text-sm text-destructive">{client.error}</p>
							)}
							{client.enabled && (
								<div className="gap-2 mt-3 flex flex-wrap">
									<Button
										variant="outline"
										disabled={busy}
										onClick={() => {
											setSelected(client.id);
											reset();
											panel.current?.scrollIntoView({ behavior: "smooth" });
										}}
									>
										Set up with assistant
									</Button>
									<Button variant="outline" onClick={() => permissions(client.id)}>
										Local tool access
									</Button>
									{signedIn && (
										<Button
											variant="outline"
											disabled={client.hosted === "connecting"}
											onClick={() =>
												void perform(() =>
													invoke(
														client.hosted === "connected" ? "hosted.disconnect" : "hosted.connect",
														{ clientId: client.id },
													),
												)
											}
										>
											{client.hosted === "connected"
												? "Disconnect hosted"
												: client.hosted === "connecting"
													? "Waiting for browser…"
													: "Connect Laplace tools"}
										</Button>
									)}
									{signedIn && (
										<Button
											variant="outline"
											disabled={client.hosted === "connecting"}
											onClick={() =>
												void perform(() =>
													invoke("hosted.connect", {
														clientId: client.id,
														desktopManagement: true,
													}),
												)
											}
										>
											Authorize desktop management
										</Button>
									)}
									<Button variant="outline" onClick={() => revoke(client.id, client.name)}>
										Revoke
									</Button>
								</div>
							)}
						</details>
					))}
				</div>
			</section>
		</div>
	);
}
