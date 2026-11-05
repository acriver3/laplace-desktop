export const acceptanceChecks: readonly string[];
export interface UpdateAcceptance {
	schemaVersion: 1;
	target: string;
	distribution: string;
	commit: string;
	artifactSha256: string;
	reviewer: string;
	completedAt: string;
	result: "passed" | "accepted";
	checks?: Record<string, "passed">;
	localValidation?: "passed";
	userAcceptance?: { statement: string; acceptedAt: string; nativeResults: "not-attested" };
}
export function verifyAcceptance(
	directory: string,
	hash: string,
	target: string,
	distribution: string,
): Promise<UpdateAcceptance>;
