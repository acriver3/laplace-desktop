import type { PointCapture, PointResult, PointTarget } from "../shared/point-contracts";
import type { PointQualification } from "./compatibility";
import type { NativeObservation } from "./native";

export interface PointHandoffDriver {
	verify: (target: PointTarget) => Promise<void>;
	observe: (target: PointTarget) => Promise<NativeObservation>;
	open: (target: PointTarget) => Promise<"ready" | "unsupported">;
	annotate: (target: PointTarget) => Promise<void>;
	attach: (target: PointTarget) => Promise<void>;
	stage: (target: PointTarget) => Promise<void>;
	focusComposer: (target: PointTarget) => Promise<void>;
	focusEditor: (target: PointTarget) => Promise<void>;
	markAttachmentAttempted: () => Promise<void>;
	markAnnotationAttempted: () => Promise<void>;
	permissionRequired?: () => void;
}
export interface HandoffOutcome {
	status: PointResult;
	message: string;
}

export async function waitFor<T>(
	read: () => Promise<T>,
	matches: (value: T) => boolean,
	timeout = 4000,
): Promise<T> {
	const deadline = Date.now() + timeout;
	do {
		const value = await read();
		if (matches(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error("Codex did not expose the expected control. Your snip is retained.");
}

export class PointHandoff {
	private baseline?: NativeObservation;
	private staged = false;
	private editorClosedAt?: number;
	constructor(
		private readonly driver: PointHandoffDriver,
		private readonly capture: PointCapture,
		private readonly qualification?: PointQualification,
	) {}
	private target() {
		if (!this.capture.target)
			throw new Error("Open the intended Codex chat, then retry this snip.");
		return this.capture.target;
	}
	async start(): Promise<HandoffOutcome> {
		if (this.capture.handoffComplete || this.capture.annotationAttempted)
			throw new Error(
				"This snip may already be in Codex. Check the draft; use Copy snip if needed.",
			);
		const target = this.target();
		await this.driver.verify(target);
		this.baseline = await this.driver.observe(target);
		if (this.baseline.editor || this.baseline.stage || this.baseline.permission)
			throw new Error("Save or cancel the existing Codex annotation before adding another snip.");
		if (!this.qualification || (await this.driver.open(target)) === "unsupported")
			return this.attach(
				"Native annotations are unavailable for this Codex build. Screenshot added; type your comment in the draft.",
			);
		await this.driver.verify(target);
		this.capture.annotationAttempted = true;
		await this.driver.markAnnotationAttempted();
		await this.driver.annotate(target);
		const opened = await waitFor(
			() => this.driver.observe(target),
			(state) => state.editor || !!state.permission,
		);
		if (opened.permission && !opened.editor) {
			this.driver.permissionRequired?.();
			// The user makes Codex's site-permission decision. Acceptance is still
			// verified by the real editor, never by the page's API response.
			const decision = await waitFor(
				() => this.driver.observe(target),
				(state) => state.editor || !state.permission,
				120_000,
			);
			if (!decision.editor) {
				try {
					await waitFor(
						() => this.driver.observe(target),
						(state) => state.editor,
						3000,
					);
				} catch {
					throw new Error(
						"Codex did not allow the annotation. Enable Annotation features in Site tools, then use the retained snip page.",
					);
				}
			}
		}
		await this.driver.focusEditor(target);
		return {
			status: "editor-ready",
			message:
				this.qualification.platform === "win32"
					? "Type your comment in Codex’s popup. Press Ctrl+Enter there to add it to the draft."
					: "Type and save your comment in Codex. Point will keep it in the draft.",
		};
	}
	async attach(message: string): Promise<HandoffOutcome> {
		const target = this.target();
		if (this.capture.attachmentAttempted)
			throw new Error(
				"An attachment may already be in the draft. Check Codex; use Copy snip if needed.",
			);
		await this.driver.verify(target);
		await this.driver.focusComposer(target);
		const before = await this.driver.observe(target);
		if (!before.composer || before.editor)
			throw new Error("Codex’s composer is unavailable. Your snip is retained.");
		// Persist before the first mutating operation, including across process restarts.
		this.capture.attachmentAttempted = true;
		await this.driver.markAttachmentAttempted();
		await this.driver.attach(target);
		await waitFor(
			() => this.driver.observe(target),
			(state) => state.attachments === before.attachments + 1,
		);
		return { status: "attachment-ready", message };
	}
	/** Read-only while the user edits; move only newly saved context, never submit a turn. */
	async checkSaved(): Promise<HandoffOutcome | undefined> {
		if (this.staged || !this.baseline) return;
		const target = this.target();
		const state = await this.driver.observe(target);
		if (state.editor) {
			this.editorClosedAt = undefined;
			return;
		}
		if (state.annotations > this.baseline.annotations) {
			await this.driver.verify(target);
			this.staged = true;
			if (!this.qualification?.annotationImageDurable)
				await this.attach("Original screenshot attached alongside the annotation.");
			return {
				status: "draft-ready",
				message: "Snip and comment are in your Codex draft. Send when ready.",
			};
		}
		if (state.stage) {
			await this.driver.verify(target);
			await this.driver.stage(target);
			await waitFor(
				() => this.driver.observe(target),
				(next) => next.annotations > this.baseline!.annotations,
			);
			return this.checkSaved();
		}
		// Saving closes the separate editor before Chromium updates the draft chip.
		// Allow that transition, but never declare delivery without observing context.
		this.editorClosedAt ??= Date.now();
		if (Date.now() - this.editorClosedAt < 3000) return;
		return {
			status: "needs-attention",
			message: "The annotation was closed without verified draft context. Your snip is retained.",
		};
	}
}
