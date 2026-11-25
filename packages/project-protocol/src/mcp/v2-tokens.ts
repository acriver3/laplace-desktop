/// <reference types="node" />
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonical } from "./interface-v2";

export const schemaVersion = (value: unknown) =>
	createHash("sha256").update(canonical(value)).digest("base64url").slice(0, 22);
export function sessionTokens(secret: string, binding: unknown) {
	const sign = (payload: string) =>
		createHmac("sha256", secret)
			.update(canonical(["laplace-mcp-v2", binding, payload]))
			.digest("base64url");
	const contextId = sign("context");
	function check(id: unknown) {
		if (typeof id !== "string" || !equal(id, contextId)) throw Error("SESSION_INIT_REQUIRED");
	}
	function action(value: unknown) {
		const body = Buffer.from(canonical(value)).toString("base64url");
		return body + "." + sign(body);
	}
	function open(ref: string): unknown {
		const [body, signature, ...rest] = ref.split(".");
		if (!body || !signature || rest.length || !equal(signature, sign(body)))
			throw Error("INVALID_ACTION_REF");
		return JSON.parse(Buffer.from(body, "base64url").toString());
	}
	return { contextId, check, action, open };
}
function equal(a: string, b: string) {
	const aa = Buffer.from(a),
		bb = Buffer.from(b);
	return aa.length === bb.length && timingSafeEqual(aa, bb);
}
