import { z } from "zod";

/** Desktop reads only identity and linkable accounts; Connect owns workspace navigation. */
export const desktopAccountResponse = z.object({
	user: z.object({ id: z.string().min(1), name: z.string() }),
	accounts: z.array(z.object({ id: z.string().min(1), name: z.string() })),
});
export type DesktopAccountResponse = z.infer<typeof desktopAccountResponse>;

/** Local tools, including catalog bundles, work without an account; hosted tools do not. */
export function requiresLaplaceSignIn(method: string): boolean {
	return method === "hosted.connect";
}

export function requireStableAuthentication(isCurrent: () => boolean): void {
	if (!isCurrent()) throw new Error("The desktop profile or sign-in changed. Try again.");
}

/** Every gated action supplies a fresh server request; renderer state is not evidence. */
export async function requireLaplaceSession(
	readSession: () => Promise<unknown>,
	isCurrent: () => boolean,
): Promise<DesktopAccountResponse> {
	requireStableAuthentication(isCurrent);
	const result = await readSession();
	requireStableAuthentication(isCurrent);
	const parsed = desktopAccountResponse.safeParse(result);
	if (!parsed.success) throw new Error("Sign in to Laplace to use this feature.");
	return parsed.data;
}

/** Restore the account badge only when this profile already has cookies. */
export async function restorePersistedAccount(
	hasCookies: () => Promise<boolean>,
	isCurrent: () => boolean,
	refresh: () => Promise<void>,
): Promise<void> {
	if ((await hasCookies()) && isCurrent()) await refresh();
}
