import { Plug } from "lucide-react";

/** Local MCP connections are custom connectors, not official provider integrations. */
export function ConnectionIcon() {
	return (
		<span className="size-10 p-1 flex shrink-0 items-center justify-center" aria-hidden="true">
			<Plug className="size-6 text-muted-foreground" />
		</span>
	);
}
