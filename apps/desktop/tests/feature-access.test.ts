import { expect, it, vi } from "vitest";

import {
	desktopAccountResponse,
	requireLaplaceSession,
	requiresLaplaceSignIn,
	requireStableAuthentication,
	restorePersistedAccount,
} from "../src/main/feature-access";

const session = {
	user: { id: "user", name: "Test" },
	accounts: [],
	navigation: { connectors: "/personal-fixture/connections", builder: "/builder/new" },
};

it("restores a persisted account without probing a clean profile or loading web content", async () => {
	const refresh = vi.fn().mockResolvedValue(undefined);
	await restorePersistedAccount(
		async () => false,
		() => true,
		refresh,
	);
	expect(refresh).not.toHaveBeenCalled();
	await restorePersistedAccount(
		async () => true,
		() => false,
		refresh,
	);
	expect(refresh).not.toHaveBeenCalled();
	await restorePersistedAccount(
		async () => true,
		() => true,
		refresh,
	);
	expect(refresh).toHaveBeenCalledOnce();
});

it("requires a fresh successful server session for each action rather than a cached signed-in state", async () => {
	const read = vi
		.fn()
		.mockResolvedValueOnce(session)
		.mockRejectedValueOnce(new Error("Sign in to Laplace first."));
	await expect(requireLaplaceSession(read, () => true)).resolves.toEqual(
		desktopAccountResponse.parse(session),
	);
	await expect(requireLaplaceSession(read, () => true)).rejects.toThrow("Sign in");
	expect(read).toHaveBeenCalledTimes(2);
});

it("does not start account checks or browser sign-in during an authentication transition", async () => {
	const read = vi.fn().mockResolvedValue(session);
	let stable = false;
	const account = requireLaplaceSession(read, () => stable);
	expect(() => requireStableAuthentication(() => stable)).toThrow("changed");
	stable = true;
	await expect(account).rejects.toThrow("changed");
	expect(read).not.toHaveBeenCalled();
});

it("rejects a pre-logout account result even after logout has finished", async () => {
	let generation = 1;
	let signingOut = false;
	let resolveSession!: (value: unknown) => void;
	const read = vi.fn(() => new Promise<unknown>((resolve) => (resolveSession = resolve)));
	const originalGeneration = generation;
	const pending = requireLaplaceSession(
		read,
		() => generation === originalGeneration && !signingOut,
	);
	expect(read).toHaveBeenCalledOnce();
	signingOut = true;
	generation++;
	const lateRead = vi.fn().mockResolvedValue(session);
	const duringLogout = requireLaplaceSession(lateRead, () => !signingOut);
	await expect(duringLogout).rejects.toThrow("changed");
	expect(lateRead).not.toHaveBeenCalled();
	signingOut = false;
	resolveSession(session);
	await expect(pending).rejects.toThrow("changed");
});

it("does not authorize an operation whose profile or authentication changed during the check", async () => {
	await expect(
		requireLaplaceSession(
			async () => session,
			() => false,
		),
	).rejects.toThrow("changed");
	for (const value of [null, {}, { accounts: [] }, { ...session, user: { id: "", name: "Test" } }])
		await expect(
			requireLaplaceSession(
				async () => value,
				() => true,
			),
		).rejects.toThrow("Sign in");
});

it("gates only hosted OAuth, keeping catalog bundles and custom local controls available signed out", () => {
	expect(requiresLaplaceSignIn("hosted.connect")).toBe(true);
	for (const method of [
		"status",
		"catalog.list",
		"catalog.install",
		"catalog.authenticate",
		"catalog.verify",
		"catalog.cancel",
		"server.preview",
		"server.add",
		"server.update",
		"server.remove",
		"server.start",
		"server.stop",
		"server.restart",
		"server.permissions",
		"import.preview",
		"import.apply",
		"migration.preview",
		"migration.apply",
		"client.register",
		"client.install",
		"client.permissions",
		"client.revoke",
		"hosted.disconnect",
	])
		expect(requiresLaplaceSignIn(method)).toBe(false);
});

it("reads only identity and linkable accounts, ignoring server navigation hints", () => {
	expect(
		desktopAccountResponse.parse({
			...session,
			navigation: { connectors: "https://attacker.invalid/connections" },
			workspaces: [{ id: "other" }],
		}),
	).toEqual({ user: session.user, accounts: [] });
});
