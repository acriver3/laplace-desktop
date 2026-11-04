/** Capability hosts, URL parameters, and credentials must never enter diagnostics. */
export function sanitizeVerification(value: string, secrets: (string | undefined)[] = []) {
	let text = value;
	for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
	return text
		.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[url]")
		.replace(
			/((?:token|password|secret|authorization|api[_-]?key|cookie|set-cookie)["']?\s*[=:]\s*)(["'])(.*?)\2/gi,
			"$1[redacted]",
		)
		.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
		.replace(
			/((?:token|password|secret|authorization|api[_-]?key|cookie|set-cookie)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi,
			"$1[redacted]",
		)
		.slice(0, 2000);
}
