export const credentialMessages = {
	vault_limit:
		"This vault has more than 10,000 logins, which exceeds the current supported limit. Nothing was selected.",
	incorrect_password:
		"That email or master password wasn't accepted. Check your details and Bitwarden region, then try again.",
	verification: "Enter the verification code from Bitwarden to continue.",
	invalid_code: "That verification code wasn't accepted. Sign in again and use a fresh code.",
	api_key_required:
		"Bitwarden needs an additional account check. Use your personal API key below to connect.",
	unsupported:
		"This sign-in method isn't supported here. Try a personal API key with a master password, or use Bitwarden directly.",
	network: "Couldn't reach Bitwarden. Check your connection and server address, then retry.",
	unavailable: "The Bitwarden component isn't ready. Choose Retry to prepare it again.",
	download:
		"Couldn't prepare Bitwarden. Check your connection and retry. No unverified software was installed.",
	expired: "Your Bitwarden session has expired. Unlock again to continue.",
	signed_out: "Your Bitwarden sign-in has expired. Sign in again to reconnect your account.",
	cancelled: "Setup was cancelled. You can resume whenever you're ready.",
	busy: "Another Bitwarden operation is in progress. Wait for it to finish or cancel it.",
	browser: "This browser isn't available. Open it and retry, or choose another browser.",
	invalid: "Check the highlighted settings and try again.",
	failed: "Couldn't complete this step. Try again; your saved selections are still available.",
	account_mismatch:
		"These saved logins belong to another Bitwarden account. Sign in to that account, or remove its selected logins before switching accounts.",
} as const;
export type CredentialErrorCode = keyof typeof credentialMessages;
export type SignInChallenge = "code" | "device_code" | "api_secret" | "method";
export type BitwardenConnection = {
	mode: "legacy" | "managed";
	phase:
		| "disconnected"
		| "preparing"
		| "ready"
		| "signing_in"
		| "challenge"
		| "connected"
		| "error";
	account?: string;
	server: string;
	challenge?: SignInChallenge;
	methods?: string[];
	error?: CredentialErrorCode;
};
export type BrowserChoice = { id: string; name: string; kind: "running" | "installed" };
export type CredentialBrowserState = {
	available: boolean;
	owned: boolean;
	name?: string;
};
