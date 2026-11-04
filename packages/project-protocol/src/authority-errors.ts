const failures: Record<number, { code: string; message: string }> = {
	400: { code: "BAD_REQUEST", message: "Invalid request. Check the tool inputs and retry." },
	401: {
		code: "UNAUTHORIZED",
		message: "Authentication expired or invalid. Reconnect Laplace Connect.",
	},
	403: { code: "FORBIDDEN", message: "You do not have permission to perform this action." },
	404: { code: "NOT_FOUND", message: "The project or task is unavailable." },
	409: {
		code: "CONFLICT",
		message: "The project or task changed. Check its current state before retrying.",
	},
	413: { code: "BAD_REQUEST", message: "The request exceeds its size limit." },
	429: { code: "TOO_MANY_REQUESTS", message: "Too many requests. Wait before retrying." },
	500: {
		code: "INTERNAL_SERVER_ERROR",
		message: "Laplace could not complete this request. Retry later.",
	},
	502: {
		code: "BAD_GATEWAY",
		message: "Laplace returned an invalid service response. Retry later.",
	},
	503: {
		code: "SERVICE_UNAVAILABLE",
		message: "The Laplace service is temporarily unavailable. Retry later.",
	},
	504: { code: "TIMEOUT", message: "The Laplace service timed out. Retry later." },
};

/** Only bounded, user-facing diagnostics cross the private authority boundary. */
export function projectAuthorityFailure(
	status: number,
	message?: unknown,
	secrets: (string | undefined)[] = [],
) {
	const normalized = failures[status] ? status : 500;
	const fallback = failures[normalized]!;
	const safe =
		typeof message === "string" &&
		message.trim().length > 0 &&
		message.length <= 600 &&
		!secrets.some((secret) => secret && message.includes(secret)) &&
		!/(?:https?|wss?|postgres(?:ql)?):\/\/|\bBearer\s|(?:token|password|secret|authorization|api[_-]?key|cookie)["']?\s*[=:]|(?:\/Users\/|\/home\/|\/tmp\/|node_modules|\bprisma\b|\bSQLSTATE\b)|[\r\n]|\bat\s+\S+\s*\(|\b(?:SELECT|INSERT|UPDATE|DELETE)\b.*\b(?:FROM|INTO|SET)\b/i.test(
			message,
		) &&
		(normalized === 401 || !/reconnect|reauth|re-auth|sign in again/i.test(message));
	return {
		status: normalized,
		code: fallback.code,
		message: normalized === 401 || normalized === 500 || !safe ? fallback.message : message.trim(),
	};
}

/** Carries the safe HTTP classification through Worker ingress and MCP tool responses. */
export class ProjectAuthorityError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, message?: unknown, secrets: (string | undefined)[] = []) {
		const failure = projectAuthorityFailure(status, message, secrets);
		super(failure.message);
		this.name = "ProjectAuthorityError";
		this.status = failure.status;
		this.code = failure.code;
	}
}
