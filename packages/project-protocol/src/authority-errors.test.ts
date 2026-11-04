import { expect, it } from "vitest";

import { projectAuthorityFailure } from "./authority-errors";

it("reserves reconnect guidance for authentication while preserving actionable conflicts", () => {
	expect(projectAuthorityFailure(401, "raw credential").message).toContain("Reconnect");
	expect(projectAuthorityFailure(409, "Completion operation_id is stale.")).toMatchObject({
		code: "CONFLICT",
		message: "Completion operation_id is stale.",
	});
	for (const status of [400, 403, 404, 409, 429, 500, 502, 503, 504, 302])
		expect(
			projectAuthorityFailure(status, "Reconnect because this request failed").message,
		).not.toContain("Reconnect");
});
it.each([
	"Bearer private-token",
	"password=secret",
	"https://private.example?token=secret",
	"postgresql://private-db",
	"/Users/private/file.ts",
	"error\n at module(file.ts:1)",
	"Prisma database failure",
	"SELECT password FROM users",
	"session-private",
	"x".repeat(601),
])("rejects unsafe authority diagnostics %s", (message) => {
	expect(projectAuthorityFailure(400, message, ["session-private"]).message).toBe(
		"Invalid request. Check the tool inputs and retry.",
	);
});
