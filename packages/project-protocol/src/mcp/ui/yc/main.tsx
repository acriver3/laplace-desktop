import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { ycViewSchema, type YcView } from "../../yc-schema";
import { askWithContext, callTool, openLink, subscribe } from "../bridge";
import {
	answer,
	chooseProposal,
	dirty,
	draftKey,
	editAnswer,
	mergeSnapshot,
	resolveConflict,
	validation,
	type Draft,
} from "./state";

interface State {
	view?: YcView;
	drafts: Record<string, Draft>;
	incoming?: YcView;
	busy: string;
	error: string;
	notice: string;
}
function receive(state: State, view: YcView): State {
	const key = draftKey(view);
	return {
		...state,
		view,
		error: "",
		drafts: view.application
			? {
					...state.drafts,
					[key]: mergeSnapshot(state.drafts[key], view.application, view.changes, view.field),
				}
			: state.drafts,
	};
}
function App() {
	const [state, setState] = useState<State>({ drafts: {}, busy: "", error: "", notice: "" });
	const view = state.view,
		key = view ? draftKey(view) : "",
		draft = state.drafts[key];
	const blocked = Boolean(state.busy);
	const question = draft?.snapshot.questions.find((item) => item.field === draft.field);
	const issue = draft ? validation(draft) : undefined;
	useEffect(
		() =>
			subscribe((result) => {
				if (result.isError) {
					setState((current) => ({
						...current,
						error: "The application could not be loaded. Refresh or reconnect in Laplace.",
					}));
					return;
				}
				const parsed = ycViewSchema.safeParse(result.structuredContent);
				if (!parsed.success) return;
				setState((current) =>
					current.busy || dirty(current.view ? current.drafts[draftKey(current.view)] : undefined)
						? { ...current, incoming: parsed.data }
						: receive({ ...current, incoming: undefined }, parsed.data),
				);
			}),
		[],
	);
	const changeDraft = (update: (draft: Draft) => Draft) =>
		setState((current) => ({
			...current,
			notice: "",
			drafts: { ...current.drafts, [key]: update(current.drafts[key]) },
		}));
	const identity = () => ({
		accountId: view?.accountId,
		connectionName: view?.connectionName,
		applicationId: draft?.snapshot.applicationId,
	});
	async function fetchView(input: Record<string, unknown>, status = "Loading application…") {
		setState((current) => ({ ...current, busy: status, error: "", notice: "" }));
		try {
			const result = await callTool("get_yc_application_view", input);
			const next = ycViewSchema.parse(result.structuredContent);
			setState((current) => receive(current, next));
		} catch (error) {
			setState((current) => ({
				...current,
				error: error instanceof Error ? error.message : "Could not load YC.",
			}));
		} finally {
			setState((current) => ({ ...current, busy: "" }));
		}
	}
	async function review() {
		if (!draft || issue || !dirty(draft)) return;
		setState((current) => ({
			...current,
			busy: "Checking current YC answers…",
			error: "",
			notice: "",
		}));
		try {
			const result = await callTool("preview_yc_draft", {
				...identity(),
				expectedRevision: draft.snapshot.revision,
				changes: draft.edits,
			});
			const next = ycViewSchema.parse(result.structuredContent);
			if (!next.application || !next.changes)
				throw Error("Reconnect your YC account and refresh before reviewing.");
			setState((current) => {
				const merged = receive(current, { ...next, changes: undefined });
				const currentDraft = merged.drafts[key];
				return {
					...merged,
					drafts: {
						...merged.drafts,
						[key]: {
							...currentDraft,
							review: { revision: next.application!.revision, changes: next.changes! },
						},
					},
				};
			});
		} catch (error) {
			setState((current) => ({
				...current,
				error: error instanceof Error ? error.message : "Review failed.",
				drafts: {
					...current.drafts,
					[key]: { ...current.drafts[key], review: undefined, needsRefresh: true },
				},
			}));
		} finally {
			setState((current) => ({ ...current, busy: "" }));
		}
	}
	async function save() {
		if (!draft?.review || issue) return;
		const reviewed = draft.review;
		setState((current) => ({
			...current,
			busy: "Saving and verifying on YC…",
			error: "",
			notice: "",
		}));
		try {
			const result = await callTool("save_yc_draft", {
				...identity(),
				expectedRevision: reviewed.revision,
				changes: Object.fromEntries(reviewed.changes.map((item) => [item.field, item.after])),
				confirm: true,
			});
			const next = ycViewSchema.parse(result.structuredContent);
			if (!next.saved || !next.application)
				throw Error("Save could not be verified. Reconnect and refresh current answers.");
			setState((current) => ({
				...receive(current, next),
				notice: "Draft saved to YC and verified.",
			}));
		} catch (error) {
			const message = error instanceof Error ? error.message : "The save could not be verified.";
			setState((current) => ({
				...current,
				busy: "Reading YC to check the save…",
				error: message,
				drafts: {
					...current.drafts,
					[key]: { ...current.drafts[key], review: undefined, needsRefresh: true },
				},
			}));
			// Read once after an uncertain write. Never resend the write automatically.
			try {
				const result = await callTool("get_yc_application_view", identity());
				const next = ycViewSchema.parse(result.structuredContent);
				if (!next.application) throw Error("Reconnect before reading the application.");
				const matches = reviewed.changes.every(
					(change) => next.application!.answers[change.field] === change.after,
				);
				setState((current) => ({
					...receive(current, next),
					error: matches
						? ""
						: `${message} Latest YC answers are loaded. Review the remaining changes before saving again.`,
					notice: matches ? "Verified: YC currently contains your reviewed answers." : "",
				}));
			} catch {
				/* Keep edits and require a successful refresh before another preview/save. */
			}
		} finally {
			setState((current) => ({ ...current, busy: "" }));
		}
	}
	async function ask() {
		if (!draft || !question) return;
		setState((current) => ({
			...current,
			busy: "Sending question to ChatGPT…",
			error: "",
			notice: "",
		}));
		try {
			await askWithContext(
				`Help improve my answer to this YC question: ${question.label}. Suggest a rewrite grounded in the information I have provided; do not invent facts. Stage it using render_yc_application with the current identifiers and expectedRevision, preserving my other unsaved changes. Do not save or submit it.`,
				{
					...identity(),
					field: question.field,
					question: question.label,
					helpText: question.helpText,
					expectedRevision: draft.snapshot.revision,
					savedAnswer: draft.snapshot.answers[question.field],
					currentAnswer: answer(draft, question.field),
					unsavedChanges: draft.edits,
				},
			);
			setState((current) => ({
				...current,
				notice: "Sent to ChatGPT. Suggested rewrites will be staged for your review.",
			}));
		} catch (error) {
			setState((current) => ({
				...current,
				error: error instanceof Error ? error.message : "Could not send to ChatGPT.",
			}));
		} finally {
			setState((current) => ({ ...current, busy: "" }));
		}
	}
	async function link(url: string) {
		try {
			if (new URL(url).protocol !== "https:") throw Error("This link is unavailable.");
			await openLink(url);
		} catch (error) {
			setState((current) => ({
				...current,
				error: error instanceof Error ? error.message : "Could not open the link.",
			}));
		}
	}
	const selectField = (field: string) => changeDraft((current) => ({ ...current, field }));
	const questions = draft?.snapshot.questions ?? [];
	const index = questions.findIndex((item) => item.field === draft?.field);
	const proposal = question && draft?.proposals[question.field];
	const completed = draft
		? questions.filter((item) => item.editable && answer(draft, item.field).trim()).length
		: 0;
	return (
		<main aria-busy={blocked}>
			<header>
				<div className="brand" aria-hidden="true">
					Y
				</div>
				<div>
					<p className="eyebrow">Y Combinator · via Laplace</p>
					<h1>{draft?.snapshot.title || "Your YC application"}</h1>
				</div>
			</header>
			{state.error && (
				<p className="alert" role="alert">
					{state.error}
				</p>
			)}
			{(state.busy || state.notice) && (
				<p role="status" className="status">
					{state.busy || state.notice}
				</p>
			)}
			{state.incoming && (
				<aside className="suggestion">
					<p>
						ChatGPT has sent an updated application view. Your local edits will be kept for
						comparison.
					</p>
					<button
						disabled={blocked}
						onClick={() =>
							setState((current) =>
								current.incoming
									? receive({ ...current, incoming: undefined }, current.incoming)
									: current,
							)
						}
					>
						Review incoming suggestions
					</button>
					<button
						disabled={blocked}
						onClick={() => setState((current) => ({ ...current, incoming: undefined }))}
					>
						Dismiss
					</button>
				</aside>
			)}
			{!view && (
				<p role="status">Waiting for your application. Ask ChatGPT to open the YC editor.</p>
			)}
			{view && (
				<>
					{view.state === "accounts" && (
						<section>
							<h2>Choose a Laplace account</h2>
							<div className="choices">
								{view.accounts.map((account) => (
									<button
										key={account.accountId}
										disabled={blocked}
										onClick={() => void fetchView({ accountId: account.accountId })}
									>
										{account.name}
									</button>
								))}
							</div>
						</section>
					)}
					{view.state === "connections" && (
						<section>
							<h2>Choose a YC connection</h2>
							{!view.connections.length && (
								<p>Connect your YC account in Laplace to get started.</p>
							)}
							<div className="choices">
								{view.connections.map((connection) => (
									<button
										key={connection.connectionName}
										disabled={blocked}
										onClick={() =>
											void fetchView({
												accountId: view.accountId,
												connectionName: connection.connectionName,
											})
										}
									>
										{connection.name}
										<small>{connection.status === "active" ? "Connected" : "Sign-in needed"}</small>
									</button>
								))}
							</div>
						</section>
					)}
					{view.state === "reconnect" && (
						<section>
							<h2>Sign in to YC again</h2>
							<p>
								Complete sign-in in Laplace, then select Refresh. Your staged answers stay here.
							</p>
							<button
								disabled={blocked}
								onClick={() =>
									void fetchView({ accountId: view.accountId, connectionName: view.connectionName })
								}
							>
								Refresh
							</button>
						</section>
					)}
					{view.state === "applications" && (
						<section>
							<h2>Choose an application</h2>
							{!view.applications.length && (
								<p>
									No editable applications were found. Open YC to create or check your application.
								</p>
							)}
							<div className="choices">
								{view.applications.map((application) => (
									<button
										key={application.applicationId}
										disabled={blocked}
										onClick={() =>
											void fetchView({
												accountId: view.accountId,
												connectionName: view.connectionName,
												applicationId: application.applicationId,
											})
										}
									>
										{application.title}
										<small>Open text draft</small>
									</button>
								))}
							</div>
							<button
								className="link"
								onClick={() => void link("https://apply.ycombinator.com/home")}
							>
								Open YC
							</button>
						</section>
					)}
					{view.state === "application" && draft && (
						<>
							<div className="toolbar">
								<span>
									{completed} / {questions.filter((item) => item.editable).length} supported text
									fields answered
								</span>
								<button
									disabled={blocked}
									onClick={() => void fetchView(identity(), "Refreshing current YC answers…")}
								>
									Refresh
								</button>
							</div>
							<select
								id="question-picker"
								aria-label="Question"
								value={draft.field}
								disabled={blocked}
								onChange={(event) => selectField(event.target.value)}
							>
								{[...new Set(questions.map((item) => item.section))].map((section) => (
									<optgroup key={section} label={section}>
										{questions
											.filter((item) => item.section === section)
											.map((item) => (
												<option key={item.field} value={item.field}>
													{item.label}
												</option>
											))}
									</optgroup>
								))}
							</select>
							{question ? (
								<section className="question">
									<p className="eyebrow">
										{question.section} · {index + 1} of {questions.length}
									</p>
									<h2>
										<label htmlFor="answer">{question.label}</label>
									</h2>
									{question.helpText && (
										<p id="question-help" className="help">
											{question.helpText}
										</p>
									)}
									{!question.editable && (
										<p className="help">This field is available to read here. Edit it on YC.</p>
									)}
									<textarea
										id="answer"
										rows={question.multiline ? 4 : 2}
										value={answer(draft, question.field)}
										readOnly={!question.editable}
										disabled={blocked}
										aria-describedby="question-help answer-count"
										aria-invalid={answer(draft, question.field).length > question.maxLength}
										onChange={(event) =>
											changeDraft((current) =>
												editAnswer(current, question.field, event.target.value),
											)
										}
									/>
									<div className="answer-meta">
										<span id="answer-count">
											{answer(draft, question.field).length.toLocaleString()} /{" "}
											{question.maxLength.toLocaleString()} characters
										</span>
										<span>{Object.hasOwn(draft.edits, question.field) ? "Unsaved" : "On YC"}</span>
									</div>
									{proposal && (
										<aside className="suggestion">
											<strong>
												{proposal.staged
													? "ChatGPT suggestion · unsaved"
													: "A suggestion is ready to compare"}
											</strong>
											{!proposal.staged && <pre>{proposal.value}</pre>}
											<div className="actions">
												<button
													disabled={blocked}
													onClick={() =>
														changeDraft((current) => chooseProposal(current, question.field, true))
													}
												>
													{proposal.staged ? "Keep suggestion" : "Use suggestion"}
												</button>
												<button
													disabled={blocked}
													onClick={() =>
														changeDraft((current) => chooseProposal(current, question.field, false))
													}
												>
													{proposal.staged ? "Reject suggestion" : "Keep my answer"}
												</button>
											</div>
										</aside>
									)}
									{draft.conflicts.includes(question.field) && (
										<aside className="conflict">
											<strong>This answer changed on YC</strong>
											<p>Current YC answer:</p>
											<pre>{draft.snapshot.answers[question.field] || "(empty)"}</pre>
											<div className="actions">
												<button
													disabled={blocked}
													onClick={() =>
														changeDraft((current) => resolveConflict(current, question.field, true))
													}
												>
													Keep my draft
												</button>
												<button
													disabled={blocked}
													onClick={() =>
														changeDraft((current) =>
															resolveConflict(current, question.field, false),
														)
													}
												>
													Use YC answer
												</button>
											</div>
										</aside>
									)}
									<div className="actions">
										<button disabled={blocked || !question.editable} onClick={() => void ask()}>
											Ask ChatGPT
										</button>
										{Object.hasOwn(draft.edits, question.field) && (
											<button
												disabled={blocked}
												onClick={() =>
													changeDraft((current) => resolveConflict(current, question.field, false))
												}
											>
												Discard this change
											</button>
										)}
									</div>
									<nav aria-label="Questions">
										<button
											disabled={blocked || index <= 0}
											onClick={() => selectField(questions[index - 1].field)}
										>
											Previous
										</button>
										<button
											disabled={blocked || index >= questions.length - 1}
											onClick={() => selectField(questions[index + 1].field)}
										>
											Next
										</button>
									</nav>
								</section>
							) : (
								<p>No supported text questions were found. Open the application on YC.</p>
							)}
							{issue && (
								<p className="alert" role="status">
									{issue}
								</p>
							)}
							{draft.conflicts.length > 0 && (
								<div className="actions">
									{draft.conflicts.map((field) => (
										<button key={field} disabled={blocked} onClick={() => selectField(field)}>
											Compare {questions.find((item) => item.field === field)?.label || field}
										</button>
									))}
								</div>
							)}
							{draft.review && (
								<section className="review">
									<h2>Review changes</h2>
									<p>These changes update your draft. They do not submit your application.</p>
									{draft.review.changes.map((change) => (
										<article key={change.field}>
											<h3>
												{questions.find((item) => item.field === change.field)?.label ||
													change.field}
											</h3>
											<p className="eyebrow">On YC</p>
											<pre>{change.before || "(empty)"}</pre>
											<p className="eyebrow">Your draft</p>
											<pre>{change.after || "(empty)"}</pre>
										</article>
									))}
									<button
										className="primary"
										disabled={blocked || Boolean(issue)}
										onClick={() => void save()}
									>
										Save draft to YC
									</button>
								</section>
							)}
							<footer className="actions">
								<button
									className="primary"
									disabled={blocked || !dirty(draft) || Boolean(issue)}
									onClick={() => void review()}
								>
									Review changes{dirty(draft) ? ` (${Object.keys(draft.edits).length})` : ""}
								</button>
								<button disabled={blocked} onClick={() => void link(draft.snapshot.url)}>
									Open in YC
								</button>
								{dirty(draft) && (
									<button
										disabled={blocked}
										onClick={() =>
											changeDraft((current) => ({
												...mergeSnapshot(undefined, current.snapshot, [], current.field),
												needsRefresh: current.needsRefresh,
											}))
										}
									>
										Discard all changes
									</button>
								)}
							</footer>
						</>
					)}
					<div className="footer-links">
						<button className="link" disabled={blocked} onClick={() => void fetchView({})}>
							Accounts & applications
						</button>
						<button
							className="link"
							disabled={blocked}
							onClick={() => void link(view.connectionsUrl)}
						>
							Manage YC connection
						</button>
					</div>
				</>
			)}
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
