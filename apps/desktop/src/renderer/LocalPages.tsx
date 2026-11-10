import { Button } from "@repo/ui/components/button";
import { AssistantSetupView } from "@repo/ui/components/connector/page-views";
import { SettingsItem } from "@repo/ui/components/connector/settings-item";
import { SettingsList } from "@repo/ui/components/connector/settings-list";
import { Bot, Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import claudeLogo from "../../../connector/public/images/provider-logos/claude-color.a3101f3047a119aa.svg";
import claudeCodeLogo from "../../../connector/public/images/provider-logos/claudecode-color.670b3d8d749d0815.svg";
import codexLogo from "../../../connector/public/images/provider-logos/codex-color.4a2f43ce46b5b6e3.svg";
import type { DesktopSnapshot } from "../shared/helper-contracts";
import type { Profile, ShellState } from "../shared/shell-contracts";
import { SettingLabel } from "./SettingControls";
import { invoke, type Perform } from "./types";

export type SetupTarget = "codex" | "claude-code" | "claude-desktop" | "other";
const assistants = [
	{ id: "codex", label: "Codex", icon: <img src={codexLogo} alt="" /> },
	{ id: "claude-code", label: "Claude Code", icon: <img src={claudeCodeLogo} alt="" /> },
	{ id: "claude-desktop", label: "Claude Desktop", icon: <img src={claudeLogo} alt="" /> },
	{ id: "other", label: "Other", icon: <Bot aria-hidden="true" /> },
];

export function LocalSetup({
	compact = false,
	target,
	selectTarget,
	children,
	footer,
}: {
	compact?: boolean;
	target: SetupTarget;
	selectTarget: (value: SetupTarget) => void;
	children: ReactNode;
	footer?: ReactNode;
}) {
	const name = assistants.find((option) => option.id === target)!.label;
	return (
		<AssistantSetupView
			compact={compact}
			label={compact ? "Use with your AI assistant" : "Set up your AI assistant"}
			stepsLabel="Setup steps"
			choice={{
				title: compact ? "Use with your AI assistant" : "Choose your AI assistant",
				label: "AI assistants",
				options: assistants,
				selected: target,
				onSelect: (value) => selectTarget(value as SetupTarget),
				selectionLabel: `Selected: ${name}`,
				checkIcon: <Check className="standard-setup-check" aria-hidden="true" />,
			}}
			setup={{
				title: compact ? undefined : `Add Laplace to ${name === "Other" ? "your AI client" : name}`,
				description: compact
					? undefined
					: "Send a setup message to your assistant. It will help connect Laplace and check that it works.",
				content: children,
			}}
			followUpSteps={
				compact
					? []
					: [
							{
								id: "verify",
								title: "Verify with your assistant",
								description:
									"Review and send the setup draft in your assistant. Follow its reload or restart instructions, then ask it to list the tools available through Laplace.",
								content: (
									<details>
										<summary>Troubleshooting</summary>
										<p>
											Keep Laplace running and check that your connections are enabled. Use Local
											tool access to review what each client can use.
										</p>
									</details>
								),
							},
						]
			}
			footer={footer}
		/>
	);
}

export function LocalInfo({ shell, snapshot }: { shell: ShellState; snapshot?: DesktopSnapshot }) {
	return (
		<section className="desktop-settings-panel" aria-label="Device information">
			<SettingsItem title="About this device">
				<dl className="desktop-info-grid">
					<div>
						<dt>Desktop version</dt>
						<dd>{shell.updates?.installedVersion ?? "—"}</dd>
					</div>
					<div>
						<dt>Local runtime</dt>
						<dd>
							{shell.helperError ? "Needs attention" : snapshot?.endpoint ? "Ready" : "Starting"}
						</dd>
					</div>
					<div>
						<dt>Connections</dt>
						<dd>{snapshot?.servers.length ?? "—"}</dd>
					</div>
					<div>
						<dt>Available tools</dt>
						<dd>{snapshot?.localTools.length ?? "—"}</dd>
					</div>
					<div>
						<dt>
							<SettingLabel
								label="Credential storage"
								hint="Connections and credentials stay on this device. Secrets are protected by your operating system's keychain."
							/>
						</dt>
						<dd>OS keychain</dd>
					</div>
					<div>
						<dt>
							<SettingLabel
								label="Closing the window"
								hint="Tools keep running in the background when you close the window. Use Stop Laplace Runtime in the tray to stop them."
							/>
						</dt>
						<dd>Keep tools running</dd>
					</div>
				</dl>
			</SettingsItem>
		</section>
	);
}

export function LocalSettings({
	shell,
	snapshot,
	changeProfile,
	perform,
	unlink,
}: {
	shell: ShellState;
	snapshot?: DesktopSnapshot;
	changeProfile: (profile: Profile) => void;
	perform: Perform;
	unlink: () => void;
}) {
	const [accountId, setAccountId] = useState("");
	useEffect(() => {
		setAccountId("");
	}, [shell.profile, shell.account?.id]);
	const linked = !!snapshot?.accountId && snapshot.mode !== "local-only";
	return (
		<SettingsList>
			<section className="desktop-settings-panel" aria-label="Workspace settings">
				<SettingsItem
					title={
						<SettingLabel
							label="Workspace linking"
							hint="Link this installation to share connections with a Laplace workspace. Workspace permissions apply; connections marked local-only stay local. This is separate from the workspace open in Laplace."
						/>
					}
				>
					<div className="desktop-settings-content">
						{snapshot?.error && <p role="alert">{snapshot.error}</p>}
						{linked ? (
							<>
								<p>
									{snapshot?.mode === "linked-blocked"
										? "Workspace access needs attention."
										: "This installation is linked."}
								</p>
								<div className="desktop-settings-actions">
									{snapshot?.mode === "linked-blocked" &&
										shell.accounts.some((account) => account.id === snapshot.accountId) && (
											<Button
												variant="outline"
												onClick={() =>
													void perform(
														() =>
															invoke("shell.link", {
																accountId: snapshot.accountId,
																name: "Laplace Desktop",
															}),
														"Workspace reconnected with existing restrictions.",
													)
												}
											>
												Reconnect workspace
											</Button>
										)}
									<Button variant="outline" onClick={unlink}>
										Unlink installation
									</Button>
								</div>
							</>
						) : shell.account ? (
							<>
								<div className="desktop-setting-field">
									<label htmlFor="link-workspace">Workspace to link</label>
									<select
										id="link-workspace"
										value={accountId}
										onChange={(event) => setAccountId(event.target.value)}
									>
										<option value="">Select workspace…</option>
										{shell.accounts.map((account) => (
											<option key={account.id} value={account.id}>
												{account.name}
											</option>
										))}
									</select>
								</div>
								<div className="desktop-settings-actions">
									<Button
										variant="outline"
										disabled={!accountId}
										onClick={() =>
											void perform(
												() => invoke("shell.link", { accountId, name: "Laplace Desktop" }),
												"Workspace linked. Review permissions for new tools.",
											)
										}
									>
										Link workspace
									</Button>
								</div>
								{!shell.accounts.length && (
									<p>No workspaces currently support linking this installation.</p>
								)}
							</>
						) : (
							<div className="desktop-settings-actions">
								<Button
									variant="outline"
									onClick={() => void perform(() => invoke("shell.signIn"))}
								>
									Sign in to link a workspace
								</Button>
							</div>
						)}
					</div>
				</SettingsItem>
			</section>
			<section className="desktop-settings-panel" aria-label="Environment settings">
				<SettingsItem
					title={
						<SettingLabel
							label="Environment"
							hint="Each environment keeps separate connections, credentials, and AI clients. Switching stops the current environment's MCP processes."
						/>
					}
				>
					<div className="desktop-setting-field">
						<label htmlFor="profile" className="sr-only">
							Environment
						</label>
						<select
							id="profile"
							value={shell.profile}
							onChange={(event) => changeProfile(event.target.value as Profile)}
						>
							<option value="hosted">Laplace</option>
							<option value="local">Local development</option>
						</select>
					</div>
				</SettingsItem>
			</section>
		</SettingsList>
	);
}
