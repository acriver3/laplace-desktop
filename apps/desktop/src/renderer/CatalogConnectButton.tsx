import { Button } from "@repo/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@repo/ui/components/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";

import {
	catalogSetupNames,
	catalogSetupTarget,
	type CatalogSetupTarget,
	type CatalogSetupResult,
} from "../shared/catalog-setup";
import { BrokerStart } from "./BrokerStart";
import { invoke, type CatalogEntry } from "./types";

export function CatalogConnectButton({
	entry,
	busy,
	manual,
}: {
	entry: CatalogEntry;
	busy: boolean;
	manual: () => void;
}) {
	const [pending, setPending] = useState(false);
	const [result, setResult] = useState<CatalogSetupResult>();
	const [error, setError] = useState("");
	async function install() {
		setPending(true);
		setError("");
		try {
			await invoke("portable.install", {
				catalogId: entry.id,
				configuration: {},
				idempotencyKey: crypto.randomUUID(),
			});
		} catch {
			setError("Installation could not start. Check connection details.");
		} finally {
			setPending(false);
		}
	}
	async function handoff(target: CatalogSetupTarget) {
		setPending(true);
		setError("");
		try {
			setResult(
				await invoke<CatalogSetupResult>("shell.catalogSetup", {
					catalogId: entry.id,
					target,
					action: "open",
				}),
			);
		} catch {
			setError("Could not prepare setup. Try manual setup.");
		} finally {
			setPending(false);
		}
	}
	return (
		<div className="catalog-connect-actions">
			<BrokerStart entries={[entry]} label="Connect" />
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button variant="outline" size="icon" disabled={busy || pending || !entry.available} />
					}
					aria-label={`More setup options for ${entry.name}`}
				>
					<MoreHorizontal className="size-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => void install()}>Install on this device</DropdownMenuItem>
					<DropdownMenuItem onClick={manual}>Set up manually</DropdownMenuItem>
					<DropdownMenuSeparator />
					{catalogSetupTarget.options.map((target) => (
						<DropdownMenuItem key={target} onClick={() => void handoff(target)}>
							Set up with {catalogSetupNames[target]}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			{pending && <p role="status">Preparing setup…</p>}
			{error && <p role="alert">{error}</p>}
			{result && (
				<div className="connection-handoff">
					<p role="status">
						{result.opened
							? "Review and send the draft in your assistant."
							: "Copy this request into your assistant."}
					</p>
					<Button onClick={() => void navigator.clipboard.writeText(result.prompt)}>
						Copy request
					</Button>
					<details>
						<summary>View request</summary>
						<pre>{result.prompt}</pre>
					</details>
				</div>
			)}
		</div>
	);
}
