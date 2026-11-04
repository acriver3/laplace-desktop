/** Release legacy HTTP state before closing the transport. Modern MCP has no session. */
export async function closeMcpConnection(
	client?: { close(): Promise<void> },
	transport?: { close(): Promise<void>; sessionId?: string; terminateSession?(): Promise<void> },
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (transport?.sessionId && transport.terminateSession) {
			await Promise.race([
				transport.terminateSession().catch(() => {}),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 1000);
				}),
			]);
		}
	} finally {
		clearTimeout(timer);
		await client?.close().catch(() => {});
		await transport?.close().catch(() => {});
	}
}
