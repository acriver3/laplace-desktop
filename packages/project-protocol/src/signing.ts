import { sign, verify } from "./security";

type RequestAudience =
	| "hosted-codex"
	| "hosted-codex-tool"
	| "project-metadata"
	| "inventory-read"
	| "workspace"
	| "gateway"
	| "project"
	| "project-gateway"
	| "builder"
	| "builder-gateway"
	| "builder-capability"
	| "connect-authority"
	| "connect-dispatch"
	| "app-connection"
	| "connect-project";

// The historical browser- prefix is part of the published app wire protocol.
// Preserve it so existing deployed Workers can authenticate requests unchanged.
export async function signedWorkspaceHeaders(
	secret: string,
	audience: RequestAudience,
	body: string,
) {
	if (secret.length < 32) throw new Error("Project signing is not configured.");
	const time = String(Date.now());
	return {
		"Content-Type": "application/json",
		"X-Laplace-Time": time,
		"X-Laplace-Signature": await sign(secret, `browser-${audience}.${time}.${body}`),
	};
}

export async function verifyWorkspaceRequest(
	request: Request,
	secret: string | undefined,
	audience: RequestAudience,
	body: string,
) {
	const time = request.headers.get("X-Laplace-Time") ?? "";
	return Boolean(
		secret &&
		secret.length >= 32 &&
		/^\d+$/.test(time) &&
		Math.abs(Date.now() - Number(time)) < 30_000 &&
		(await verify(
			secret,
			`browser-${audience}.${time}.${body}`,
			request.headers.get("X-Laplace-Signature") ?? "",
		)),
	);
}
