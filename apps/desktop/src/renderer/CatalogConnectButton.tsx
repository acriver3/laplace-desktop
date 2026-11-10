import { Button } from "@repo/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
} from "@repo/ui/components/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";

import {
	catalogSetupNames,
	catalogSetupError,
	catalogSetupTarget,
	type CatalogSetupTarget,
	type CatalogSetupResult,
} from "../shared/catalog-setup";
import { invoke, type CatalogEntry } from "./types";
import { useSetupAgent } from "./useSetupAgent";

export function CatalogConnectButton({
	entry,
	busy = false,
	connectionId,
	label = "Connect",
}: {
	entry: CatalogEntry;
	busy?: boolean;
	connectionId?: string;
	label?: string;
}) {
	const [agent, rememberAgent] = useSetupAgent();
	const [pickerOpen, setPickerOpen] = useState(false);
	const [connectOnSelect, setConnectOnSelect] = useState(false);
	const [pending, setPending] = useState(false);
	const [result, setResult] = useState<CatalogSetupResult>();
	const [error, setError] = useState("");
	const [copied, setCopied] = useState(false);
	const working = useRef(false);
	const disabled = busy || pending || !entry.available;

	async function handoff(target: CatalogSetupTarget) {
		if (working.current) return;
		working.current = true;
		setPending(true);
		setError("");
		setCopied(false);
		setResult(undefined);
		try {
			setResult(
				await invoke<CatalogSetupResult>("shell.catalogSetup", {
					catalogId: entry.id,
					...(connectionId ? { connectionId } : {}),
					target,
					action: "open",
				}),
			);
		} catch (error) {
			setError(catalogSetupError(error));
		} finally {
			working.current = false;
			setPending(false);
		}
	}

	async function copy() {
		if (!result) return;
		try {
			await navigator.clipboard.writeText(result.prompt);
			setError("");
			setCopied(true);
		} catch {
			setError("Could not copy the request. Select and copy it from View request below.");
		}
	}

	return (
		<div className="catalog-connect-actions">
			<Button
				variant="primary"
				disabled={disabled}
				onClick={() => {
					if (agent) void handoff(agent);
					else {
						setConnectOnSelect(true);
						setPickerOpen(true);
					}
				}}
			>
				{pending ? "Preparing…" : label}
			</Button>
			<DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
				<DropdownMenuTrigger
					render={<Button variant="outline" size="icon" disabled={disabled} />}
					aria-label={`Change agent for ${entry.name}`}
					title={agent ? `Set up with ${catalogSetupNames[agent]}` : "Choose an agent"}
					onClick={() => setConnectOnSelect(false)}
				>
					<ChevronDown className="size-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{catalogSetupTarget.options.map((target) => (
						<DropdownMenuItem
							key={target}
							onClick={() => {
								rememberAgent(target);
								setPickerOpen(false);
								setResult(undefined);
								setError("");
								if (connectOnSelect) void handoff(target);
							}}
						>
							{catalogSetupNames[target]}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			{error && <p role="alert">{error}</p>}
			{result && (
				<div className="connection-handoff">
					<p role="status">
						{copied
							? "Request copied. Paste and send it in your agent."
							: result.opened
								? "Review and send the draft in your agent."
								: "Copy this request into your agent."}
					</p>
					<Button onClick={() => void copy()}>Copy request</Button>
					<details>
						<summary>View request</summary>
						<pre>{result.prompt}</pre>
					</details>
				</div>
			)}
		</div>
	);
}
