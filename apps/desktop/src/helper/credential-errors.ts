import { credentialMessages, type CredentialErrorCode } from "../shared/credential-setup";
export class CredentialSetupError extends Error {
	constructor(readonly code: CredentialErrorCode) {
		super(credentialMessages[code]);
	}
}
/** Classify private subprocess output; never return that output or an unrecognized message. */
export function bitwardenError(raw: string): CredentialSetupError {
	if (/(two.step|verification).*(invalid|incorrect)|invalid.*(token|code)/i.test(raw))
		return new CredentialSetupError("invalid_code");
	if (/incorrect|invalid master password|invalid_client|invalid email|password.*invalid/i.test(raw))
		return new CredentialSetupError("incorrect_password");
	if (/captcha|bot\.|additional authentication|client_secret|no providers available/i.test(raw))
		return new CredentialSetupError("api_key_required");
	if (/sso|trusted device encryption|passkey|legacyEncryption|master password.*polic/i.test(raw))
		return new CredentialSetupError("unsupported");
	if (/fetch failed|ENOTFOUND|ECONN|timed? ?out|network|unable to fetch/i.test(raw))
		return new CredentialSetupError("network");
	if (/not logged in|session.*expired|invalid.*session/i.test(raw))
		return new CredentialSetupError("signed_out");
	if (/locked/i.test(raw)) return new CredentialSetupError("expired");
	return new CredentialSetupError("failed");
}
