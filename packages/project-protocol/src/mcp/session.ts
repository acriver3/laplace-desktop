import { sign, verify } from "../security";

export const CONNECT_SESSION_PREFIX = "connect-v1.";
const binding = (origin: string, principal: string, id: string) =>
	JSON.stringify(["connect-mcp-session-v1", origin, principal, id]);

export async function connectSession(
	secret: string,
	origin: string,
	principal: string,
	id: string,
) {
	return `${CONNECT_SESSION_PREFIX}${id}.${await sign(secret, binding(origin, principal, id))}`;
}

/** A malformed Connect envelope never falls through to the legacy backend. */
export async function readConnectSession(
	secret: string,
	origin: string,
	principal: string,
	session: string,
) {
	if (session.length > 1024 || !session.startsWith(CONNECT_SESSION_PREFIX)) return null;
	const split = session.lastIndexOf(".");
	const id = session.slice(CONNECT_SESSION_PREFIX.length, split);
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return null;
	return (await verify(secret, binding(origin, principal, id), session.slice(split + 1)))
		? id
		: null;
}
