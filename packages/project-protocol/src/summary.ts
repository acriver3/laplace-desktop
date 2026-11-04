import { PROJECT_VERIFICATION_KIND, type ProjectStatus } from "./index";

export function currentRuntimeVerification(
	state: Pick<ProjectStatus, "preview_revision" | "verification"> | undefined,
) {
	return state?.preview_revision &&
		state.verification?.kind === PROJECT_VERIFICATION_KIND &&
		state.verification.revision === state.preview_revision
		? state.verification
		: undefined;
}

export function verificationLabel(value: unknown) {
	const status =
		value && typeof value === "object" && "verification" in value ? value.verification : value;
	return status === "passed"
		? "Passed"
		: status === "failed"
			? "Failed"
			: status === "pending"
				? "Checking"
				: status === "unavailable"
					? "Unavailable"
					: "Not run";
}

/** Deployment availability and current build/runtime assurance are independent facts. */
export function projectSummary(data?: Record<string, unknown>) {
	const state = data as unknown as ProjectStatus | undefined;
	const preview = state?.environment_status?.preview;
	const live = state?.environment_status?.live;
	const verification = verificationLabel(currentRuntimeVerification(state));
	return {
		preview:
			state?.preview && ["updating", "ready", "failed"].includes(state.preview.status)
				? state.preview.status === "updating"
					? "Updating"
					: state.preview.status === "failed"
						? "Update failed"
						: "Ready"
				: !state
					? "Unknown"
					: state.preview_revision
						? preview === "building"
							? "Deployed · updating"
							: preview === "failed"
								? "Deployed · update failed"
								: "Deployed"
						: preview === "building"
							? "Building"
							: preview === "failed"
								? "Update failed"
								: "Not deployed",
		verification: !state ? "Unknown" : verification,
		live: !state
			? "Unknown"
			: live === "publishing"
				? "Publishing"
				: live === "failed"
					? "Publish failed"
					: state.live_revision
						? "Published"
						: "Not published",
	};
}
