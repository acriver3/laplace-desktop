import type { YcChange, YcSnapshot, YcView } from "../../yc-schema";

export interface Proposal {
	value: string;
	previous: string;
	staged: boolean;
}
export interface Draft {
	snapshot: YcSnapshot;
	edits: Record<string, string>;
	proposals: Record<string, Proposal>;
	conflicts: string[];
	field: string;
	needsRefresh: boolean;
	review?: { revision: string; changes: YcChange[] };
}
export const draftKey = (view: YcView) =>
	JSON.stringify([view.accountId, view.connectionName, view.application?.applicationId]);
export const dirty = (draft?: Draft) => Boolean(draft && Object.keys(draft.edits).length);
export const answer = (draft: Draft, field: string) =>
	draft.edits[field] ?? draft.snapshot.answers[field] ?? "";

export function editAnswer(draft: Draft, field: string, value: string): Draft {
	const edits = { ...draft.edits },
		proposals = { ...draft.proposals };
	if (value === draft.snapshot.answers[field]) delete edits[field];
	else edits[field] = value;
	delete proposals[field];
	return { ...draft, edits, proposals, review: undefined };
}

/** Refresh server truth without losing local edits. Overlapping external edits require a choice. */
export function mergeSnapshot(
	previous: Draft | undefined,
	snapshot: YcSnapshot,
	changes: YcChange[] = [],
	field?: string,
): Draft {
	const edits = { ...previous?.edits },
		proposals = { ...previous?.proposals };
	const conflicts = new Set(previous?.conflicts ?? []);
	for (const [name, value] of Object.entries(edits)) {
		if (snapshot.answers[name] === value) {
			delete edits[name];
			delete proposals[name];
			conflicts.delete(name);
		} else if (
			previous?.snapshot.answers[name] !== snapshot.answers[name] ||
			!snapshot.questions.find((question) => question.field === name)?.editable
		)
			conflicts.add(name);
	}
	for (const change of changes) {
		if (!snapshot.questions.find((question) => question.field === change.field)?.editable) continue;
		if (
			change.before !== snapshot.answers[change.field] ||
			change.after === snapshot.answers[change.field]
		)
			continue;
		const current = edits[change.field] ?? snapshot.answers[change.field];
		if (current === change.after) continue;
		const staged = !Object.hasOwn(edits, change.field);
		proposals[change.field] = { value: change.after, previous: current, staged };
		if (staged) edits[change.field] = change.after;
	}
	const selected = field ?? previous?.field;
	return {
		snapshot,
		edits,
		proposals,
		conflicts: [...conflicts],
		needsRefresh: false,
		field: snapshot.questions.some((question) => question.field === selected)
			? selected!
			: (snapshot.questions[0]?.field ?? ""),
	};
}

export function chooseProposal(draft: Draft, field: string, accept: boolean): Draft {
	const proposal = draft.proposals[field];
	if (!proposal) return draft;
	return editAnswer(
		draft,
		field,
		accept ? proposal.value : proposal.staged ? proposal.previous : answer(draft, field),
	);
}
export function resolveConflict(draft: Draft, field: string, keepDraft: boolean): Draft {
	const next = keepDraft
		? { ...draft, review: undefined }
		: editAnswer(draft, field, draft.snapshot.answers[field] ?? "");
	return { ...next, conflicts: next.conflicts.filter((name) => name !== field) };
}
export function validation(draft: Draft): string | undefined {
	for (const [field, value] of Object.entries(draft.edits)) {
		const question = draft.snapshot.questions.find((item) => item.field === field);
		if (!question?.editable)
			return "Some edited fields are no longer available. Discard those changes or open YC.";
		if (value.length > question.maxLength)
			return `${question.label}: shorten the answer to ${question.maxLength} characters.`;
	}
	if (draft.conflicts.length)
		return "Choose which answer to keep for each changed question before reviewing.";
	if (draft.needsRefresh) return "Refresh current YC answers before reviewing or saving again.";
	return undefined;
}
