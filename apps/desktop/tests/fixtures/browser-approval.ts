import { randomUUID } from "node:crypto";

import type { BrowserConnectionRelay } from "../../src/helper/browser-connection-relay";
/** Exercise the same identity-review/authorization handshake as Desktop and the extension. */
export async function approveBrowser(
	relay: BrowserConnectionRelay,
	post: (path: string, body: unknown) => Promise<Response>,
	code: string,
	identity: Record<string, string>,
) {
	const candidate = {
		id: randomUUID(),
		revision: randomUUID(),
		profileId: randomUUID(),
		profileLabel: "Fixture",
		identity,
	};
	const reviewed = await post("/review", {
		code,
		profileId: candidate.profileId,
		profileLabel: candidate.profileLabel,
		candidates: [candidate],
		hint: "discovering",
	});
	if (!reviewed.ok) throw Error("Fixture identity review failed.");
	relay.authorize({ candidateId: candidate.id, revision: candidate.revision });
	const decision = await (await post("/decision", { code, profileId: candidate.profileId })).json();
	return post("/pair", {
		code,
		candidateId: candidate.id,
		identity,
		authorization: decision.authorization,
	});
}
