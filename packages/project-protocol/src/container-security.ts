import { sign, verify } from "./security";

export async function deploymentSecret(
	root: string,
	appId: string,
	environment: string,
	deploymentId: string,
) {
	if (root.length < 32) throw new Error("Container signing is not configured");
	return sign(root, JSON.stringify(["laplace-container-v1", appId, environment, deploymentId]));
}
export async function containerHeaders(secret: string, audience: string, body: string) {
	const time = String(Date.now());
	return {
		"Content-Type": "application/json",
		"X-Laplace-Time": time,
		"X-Laplace-Signature": await sign(secret, `${audience}.${time}.${body}`),
	};
}
export async function verifyContainerRequest(
	request: Request,
	secret: string,
	audience: string,
	body: string,
) {
	const time = request.headers.get("X-Laplace-Time") ?? "";
	return (
		secret.length >= 32 &&
		/^\d{13}$/.test(time) &&
		Math.abs(Date.now() - Number(time)) < 30000 &&
		(await verify(
			secret,
			`${audience}.${time}.${body}`,
			request.headers.get("X-Laplace-Signature") ?? "",
		))
	);
}
export interface ContainerSession {
	appId: string;
	environment: string;
	deploymentId: string;
	sessionId: string;
	expiresAt: number;
	state?: string;
	id: string;
}
export async function sessionToken(
	secret: string,
	audience: "handoff" | "session",
	claims: ContainerSession,
) {
	const value = btoa(JSON.stringify(claims));
	return `${value}.${await sign(secret, `${audience}.${value}`)}`;
}
export async function readSessionToken(
	secret: string,
	audience: "handoff" | "session",
	token: string,
): Promise<ContainerSession | null> {
	try {
		if (token.length > 4096) return null;
		const [value, signature, extra] = token.split(".");
		if (extra || !(await verify(secret, `${audience}.${value}`, signature))) return null;
		const claims = JSON.parse(atob(value)) as ContainerSession;
		if (
			typeof claims.sessionId !== "string" ||
			typeof claims.id !== "string" ||
			!Number.isFinite(claims.expiresAt) ||
			claims.expiresAt <= Date.now()
		)
			return null;
		return claims;
	} catch {
		return null;
	}
}
