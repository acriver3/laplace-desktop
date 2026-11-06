import type { ConnectorUpdateStatus } from "@repo/local-mcp-core/connector-updates";
import { useCallback, useEffect, useState } from "react";

import { invoke } from "./types";

/** One shared poll of managed connector update status for a page. */
export function useConnectorUpdates() {
	const [rows, setRows] = useState<ConnectorUpdateStatus[]>([]);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const run = useCallback(async (method: string, input?: unknown) => {
		setBusy(true);
		setError(undefined);
		try {
			const value = await invoke<ConnectorUpdateStatus[]>(method, input);
			setRows(Array.isArray(value) ? value : []);
			return true;
		} catch (error) {
			setError(error instanceof Error ? error.message : "Connector update failed");
			return false;
		} finally {
			setBusy(false);
		}
	}, []);
	useEffect(() => {
		void run("updates.connectors");
		const timer = setInterval(() => {
			void invoke<ConnectorUpdateStatus[]>("updates.connectors")
				.then((value) => setRows(Array.isArray(value) ? value : []))
				.catch(() => {});
		}, 15000);
		return () => clearInterval(timer);
	}, [run]);
	return { rows, error, busy, run };
}
