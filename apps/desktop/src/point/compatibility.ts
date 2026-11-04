import qualifications from "./qualifications.json";

export interface PointQualification {
	platform: string;
	arch: string;
	version: string;
	annotationDraft: boolean;
	annotationImageDurable: boolean;
	evidence: string;
}

/** Add an exact build only after the manual native acceptance protocol has passed. */
export function annotationQualification(
	version: string,
	platform = process.platform,
	arch = process.arch,
): PointQualification | undefined {
	return (qualifications as PointQualification[]).find(
		(entry) =>
			entry.platform === platform &&
			entry.arch === arch &&
			entry.version === version &&
			entry.annotationDraft &&
			entry.evidence.length > 0,
	);
}
