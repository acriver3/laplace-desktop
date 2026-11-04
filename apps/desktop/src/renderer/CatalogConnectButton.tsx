import { Button } from "@repo/ui/components/button";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@repo/ui/components/dropdown-menu";
import { SplitButton } from "@repo/ui/components/split-button";
import { Bot, Copy, Settings2 } from "lucide-react";
import { useState } from "react";

import logos from "../../../connector/modules/builder-logos.json";
import {
	catalogSetupNames,
	catalogSetupTarget,
	type CatalogSetupTarget,
	type CatalogSetupResult,
} from "../shared/catalog-setup";
import { BrokerStart } from "./BrokerStart";
import { invoke, type CatalogEntry } from "./types";

type SetupChoice = CatalogSetupTarget | "manual" | "install";
const assets = import.meta.glob<string>(
	"../../../connector/public/images/provider-logos/*.{svg,png,webp,jpg}",
	{ eager: true, query: "?url&no-inline", import: "default" },
);
const artwork: Partial<Record<SetupChoice, keyof typeof logos.builders>> = {
	codex: "codex-color",
	chatgpt: "openai",
	"claude-desktop": "claude-color",
	"claude-code": "claudecode-color",
	cursor: "cursor",
	hermes: "hermes",
};
function AgentIcon({ target }: { target: SetupChoice }) {
	const key = artwork[target];
	if (target === "manual") return <Settings2 className="size-6" aria-hidden="true" />;
	if (!key) return <Bot className="size-6" aria-hidden="true" />;
	return (
		<img
			src={assets[`../../../connector/public${logos.builders[key]}`]}
			alt=""
			aria-hidden="true"
			className={`size-6 shrink-0 object-contain${target === "chatgpt" || target === "cursor" ? " dark:invert" : ""}`}
		/>
	);
}

export function CatalogConnectButton({
	entry,
	busy,
	manual,
}: {
	entry: CatalogEntry;
	busy: boolean;
	manual: () => void;
}) {
	const [target, setTarget] = useState<SetupChoice>("install");
	const [pending, setPending] = useState(false);
	const [result, setResult] = useState<CatalogSetupResult>();
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string>();
	const targetName =
		target === "install"
			? "This device"
			: target === "manual"
				? "Manual setup"
				: catalogSetupNames[target];
	const copyOnly = ["cursor", "hermes", "other"].includes(target);
	async function copy(prompt: string) {
		try {
			await navigator.clipboard.writeText(prompt);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	}
	async function connect() {
		if (target === "install") {
			setPending(true);
			setError(undefined);
			try {
				await invoke("portable.install", {
					catalogId: entry.id,
					configuration: {},
					idempotencyKey: crypto.randomUUID(),
				});
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Installation could not start");
			} finally {
				setPending(false);
			}
			return;
		}
		if (target === "manual") {
			manual();
			return;
		}
		setPending(true);
		setError(undefined);
		setResult(undefined);
		setCopied(false);
		try {
			const setup = await invoke<CatalogSetupResult>("shell.catalogSetup", {
				catalogId: entry.id,
				target,
				action: copyOnly ? "instructions" : "open",
			});
			setResult(setup);
			await copy(setup.prompt);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not prepare setup. Please try again.",
			);
		} finally {
			setPending(false);
		}
	}
	return (
		<div className="catalog-connect-actions">
			<BrokerStart entries={[entry]} />
			<SplitButton
				disabled={busy || pending || !entry.available}
				variant="outline"
				className="agent-setup-button catalog-action"
				size="sm"
				menuLabel={`Choose setup agent for ${entry.name}`}
				menuDisplay={<AgentIcon target={target} />}
				onClick={() => void connect()}
				menu={
					<>
						<DropdownMenuRadioGroup
							value={target}
							onValueChange={(value) => {
								setTarget(
									value === "manual" || value === "install"
										? value
										: catalogSetupTarget.parse(value),
								);
								setResult(undefined);
								setError(undefined);
								setCopied(false);
							}}
						>
							<DropdownMenuRadioItem value="install" closeOnClick>
								Install on this device
							</DropdownMenuRadioItem>
							{catalogSetupTarget.options.map((id) => (
								<DropdownMenuRadioItem key={id} value={id} closeOnClick className="gap-2">
									<AgentIcon target={id} />
									{catalogSetupNames[id]}
								</DropdownMenuRadioItem>
							))}
							<DropdownMenuRadioItem value="manual" closeOnClick className="gap-2">
								<AgentIcon target="manual" />
								Set up manually
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
					</>
				}
			>
				{target === "install" ? "Install" : "Connect"}
			</SplitButton>
			{error && (
				<p role="alert" className="text-sm">
					{error}
				</p>
			)}
			{result && (
				<div className="min-w-0 space-y-2 text-sm w-full">
					<p role="status">
						{result.opened
							? `Continue in ${targetName} and send the prepared setup prompt.`
							: copied
								? `Setup prompt copied. Paste it into ${targetName} to continue.`
								: "Copy the setup prompt below into your agent to continue."}
						{!result.opened && !copyOnly && " If the app did not open, open it manually."}
					</p>
					<Button size="sm" variant="outline" onClick={() => void copy(result.prompt)}>
						<Copy className="size-4" />
						{copied ? "Copied" : "Copy setup prompt"}
					</Button>
					<details open={!copied && !result.opened ? true : undefined}>
						<summary>View setup prompt</summary>
						<pre
							className="max-h-64 overflow-auto break-words whitespace-pre-wrap"
							aria-label={`Setup prompt for ${entry.name}`}
						>
							{result.prompt}
						</pre>
					</details>
				</div>
			)}
		</div>
	);
}
