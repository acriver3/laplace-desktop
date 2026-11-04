/** Local discovery is available on installed Desktop; access still requires user opt-in. */
export const credentialBrokeringEnabled = () => process.env.ENABLE_CREDENTIAL_BROKERING !== "false";
