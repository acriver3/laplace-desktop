import { SdkHttpError } from "@modelcontextprotocol/client";

import { RuntimeStoppedError } from "./runtime-errors";

/** Never include response bodies, headers, or transport error text in diagnostics. */
export function bridgeConnectionMessage(error: unknown) {
	if (error instanceof RuntimeStoppedError) return error.message;
	if (error instanceof SdkHttpError) {
		if (error.status === 429)
			return "Laplace Desktop is busy. This tool call was not started. Try again after running calls finish.";
		if (error.status === 401 || error.status === 403)
			return "Laplace Desktop rejected this client's registration. Review the assistant in Setup and reconnect it. Calls were not replayed.";
	}
	return "Cannot connect to Laplace Desktop. Check the app and this client's registration.";
}

export function bridgeCallMessage(error: unknown, dispatched: boolean) {
	if (error instanceof SdkHttpError && [401, 403, 429].includes(error.status))
		return `${bridgeConnectionMessage(error)} The tool call was not started.`;
	return dispatched
		? "Laplace Desktop call failed; its outcome may be unknown. It was not replayed. Check the connector before retrying."
		: `${bridgeConnectionMessage(error)} The tool call was not started.`;
}
