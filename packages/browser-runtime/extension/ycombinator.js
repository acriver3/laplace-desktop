// Bundled adapter, executed only in the tab the user explicitly approves.
// No cookies, login credentials, arbitrary URLs, page scripts, or submit action.
export async function ycAction(method, args, expected, requestedWorkspace) {
	const origin = "https://apply.ycombinator.com";
	const fail = (code, message) => ({ ok: true, result: { error: { code, message } } });
	let attempted = false;
	try {
		if (location.origin !== origin || (requestedWorkspace || expected?.workspace) !== origin)
			return { ok: false, error: "not_yc_tab" };
		const identity = (doc) => {
			const settings = doc.querySelector('a[title="Account Settings"]');
			const userId = settings?.previousElementSibling?.textContent?.trim();
			const logout = [...doc.querySelectorAll("button")].some(
				(e) => e.textContent.trim() === "Log out",
			);
			return logout && userId && /^[A-Za-z0-9_-]{1,100}$/.test(userId)
				? { workspace: origin, userId }
				: null;
		};
		const account = identity(document);
		if (!account) return { ok: false, error: "sign_in_required" };
		if (expected && expected.userId !== account.userId)
			return { ok: false, error: "identity_mismatch" };
		const allowed = {
			"account.identify": [],
			"applications.list": [],
			"application.read": ["applicationId"],
			"application.saveDraft": ["applicationId", "expectedRevision", "changes", "confirm"],
		};
		if (
			!Object.hasOwn(allowed, method) ||
			!args ||
			typeof args !== "object" ||
			Array.isArray(args) ||
			Object.keys(args).some((k) => !allowed[method].includes(k))
		)
			return fail("INVALID_REQUEST", "Unsupported YC action or arguments.");
		if (method === "account.identify") return { ok: true, result: account };
		const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
		if (method === "applications.list") {
			const applications = new Map();
			for (const link of document.querySelectorAll("a[href]")) {
				const url = new URL(link.href);
				const id = url.pathname.match(/^\/apps\/([^/]+)\/edit$/)?.[1];
				if (url.origin === origin && id && idPattern.test(id))
					applications.set(id, {
						applicationId: id,
						url: origin + url.pathname,
						title: link.textContent.trim(),
					});
			}
			const current = location.pathname.match(/^\/apps\/([^/]+)\/edit$/)?.[1];
			if (current && idPattern.test(current))
				applications.set(current, {
					applicationId: current,
					url: origin + location.pathname,
					title: document.querySelector('input[name="name"]')?.value || "YC Application",
				});
			return {
				ok: true,
				result: {
					applications: [...applications.values()],
					scope: "Applications visible in the approved tab. Open YC home to list all applications.",
				},
			};
		}
		if (!idPattern.test(args.applicationId || ""))
			return fail("INVALID_APPLICATION_ID", "Use an application ID from list_applications.");
		const path = `/apps/${args.applicationId}/edit`;
		if (location.pathname !== path)
			return fail("OPEN_APPLICATION", "Open this application in your approved YC tab, then retry.");
		const fields = new Set(
			"others2 cofounder name describe url productLink make where wherewhy howfar worked techstack usernums since acc exp get money ideas inctype incpercent whyapply howhear".split(
				" ",
			),
		);
		const answersOf = (doc) =>
			Object.fromEntries(
				[...doc.querySelectorAll('input[name][type="text"],textarea[name]')]
					.filter((e) => fields.has(e.name))
					.map((e) => [e.name, e.value]),
			);
		const formState = (doc) =>
			Object.fromEntries(
				[
					...doc.querySelectorAll(
						'input[name]:not([type="hidden"]):not([type="file"]),textarea[name],select[name]',
					),
				].map((e, i) => [
					`${e.name}:${i}`,
					JSON.stringify({
						value: e.value,
						checked: e.checked,
						selected:
							e.tagName === "SELECT" ? [...e.selectedOptions].map((o) => o.value) : undefined,
					}),
				]),
			);
		const hash = async (answers) =>
			[
				...new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(
							JSON.stringify(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))),
						),
					),
				),
			]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		const buttons = [...document.querySelectorAll("button")].filter(
			(e) => e.textContent.trim() === "Save changes",
		);
		if (buttons.length !== 1)
			return fail("FORM_CHANGED", "YC's draft form changed. No save was attempted.");
		const answers = answersOf(document),
			revision = await hash(answers);
		if (!Object.keys(answers).length)
			return fail("FORM_CHANGED", "YC's answer fields could not be read.");
		const persisted = async () => {
			// YC hydrates its answers client-side. A fresh same-origin frame reads
			// the persisted form without navigating away from the user's draft.
			const frame = document.createElement("iframe");
			frame.hidden = true;
			frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
			frame.title = "Laplace saved-draft verification";
			frame.src = `${origin}${path}?laplace_verify=${crypto.randomUUID()}`;
			document.body.append(frame);
			try {
				const deadline = Date.now() + 8000;
				while (Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 150));
					const doc = frame.contentDocument;
					if (!doc || doc.location.origin !== origin || doc.location.pathname !== path) continue;
					const saved = answersOf(doc);
					if (
						identity(doc)?.userId !== account.userId ||
						Object.keys(saved).length !== Object.keys(answers).length
					)
						continue;
					if (
						![...doc.querySelectorAll("button")].some(
							(e) => e.textContent.trim() === "Save changes",
						)
					)
						continue;
					return { answers: saved, formRevision: await hash(formState(doc)) };
				}
				throw Error("verification_failed");
			} finally {
				frame.remove();
			}
		};
		const plain = (node) => {
			if (!node) return "";
			const copy = node.cloneNode(true);
			copy.querySelectorAll("input,textarea,select,script,style").forEach((e) => e.remove());
			return copy.textContent.replace(/\s+/g, " ").trim();
		};
		const controls = [
			...document.querySelectorAll('input[name][type="text"],textarea[name]'),
		].filter((e) => fields.has(e.name));
		const questions = controls.map((e, order) => {
			const named = document.getElementById(e.name);
			const container = named?.contains(e)
				? named
				: e.closest("fieldset,.question,[data-question]");
			const section = e.closest('section,fieldset,[data-section],[id^="f_"]');
			const help =
				(e.getAttribute("aria-describedby") || "")
					.split(/\s+/)
					.map((id) => plain(document.getElementById(id)))
					.filter(Boolean)
					.join(" ") || plain(container?.querySelector(":scope > p,.help-text,.help,small"));
			return {
				field: e.name,
				label:
					[...(e.labels || [])].map(plain).filter(Boolean).join(" ") ||
					e.getAttribute("aria-label") ||
					plain(container?.querySelector("legend,label,h3")) ||
					e.name,
				helpText: help,
				section:
					plain(section?.querySelector(".apply-section-header,legend,h2,h3")) || "Application",
				order,
				multiline: e.tagName === "TEXTAREA",
				maxLength: Math.min(
					e.maxLength >= 0 ? e.maxLength : 20000,
					e.name === "describe" ? 50 : 20000,
				),
				editable:
					!e.disabled &&
					!e.readOnly &&
					e.getClientRects().length > 0 &&
					controls.filter((other) => other.name === e.name).length === 1,
			};
		});
		const snapshot = {
			applicationId: args.applicationId,
			title: answers.name || "YC application",
			answers,
			revision,
			url: origin + path,
			questions,
		};
		if (method === "application.read") {
			const saved = await persisted();
			return {
				ok: true,
				result: { ...snapshot, answers: saved.answers, revision: await hash(saved.answers) },
			};
		}
		if (args.expectedRevision !== revision)
			return fail("CONFLICT", "Answers changed. Read the application again before editing.");
		if (
			!args.changes ||
			typeof args.changes !== "object" ||
			Array.isArray(args.changes) ||
			!Object.keys(args.changes).length ||
			Object.keys(args.changes).length > 30 ||
			(args.confirm !== undefined && typeof args.confirm !== "boolean")
		)
			return fail(
				"INVALID_CHANGES",
				"Provide draft answer changes and an optional boolean confirm.",
			);
		const changes = Object.entries(args.changes).map(([field, after]) => ({
			field,
			before: answers[field],
			after,
		}));
		if (
			changes.some(
				(c) =>
					!fields.has(c.field) ||
					!Object.hasOwn(answers, c.field) ||
					!questions.find((q) => q.field === c.field)?.editable ||
					typeof c.after !== "string" ||
					c.after.length > questions.find((q) => q.field === c.field).maxLength ||
					c.after.length > 20000 ||
					(c.field === "describe" && c.after.length > 50),
			)
		)
			return fail(
				"INVALID_FIELD",
				"Only supported text answers can be edited. The short description allows 50 characters.",
			);
		if (args.confirm !== true) return { ok: true, result: { ...snapshot, preview: true, changes } };
		if (changes.every((c) => c.before === c.after))
			return { ok: true, result: { ...snapshot, unchanged: true, saved: false } };
		if (buttons[0].disabled)
			return fail("FORM_BUSY", "Wait for YC to finish its current operation, then read again.");

		// A save submits the whole visible form. Preserve manual edits by refusing
		// to save when the visible draft differs from the persisted page.
		const beforeSave = await persisted();
		if (
			beforeSave.formRevision !== (await hash(formState(document))) ||
			[...document.querySelectorAll('input[type="file"]')].some((e) => e.files.length)
		)
			return fail(
				"UNSAVED_CHANGES",
				"Save your existing manual edits in YC first, then read the application again.",
			);
		if (
			(await hash(answersOf(document))) !== revision ||
			identity(document)?.userId !== account.userId
		)
			return fail("CONFLICT", "The tab changed during verification. Read again.");
		const nodes = changes.map((c) => document.querySelector(`[name="${c.field}"]`));
		if (nodes.some((e) => !e || e.disabled || e.readOnly))
			return fail("FORM_CHANGED", "YC's draft fields changed. No save was attempted.");
		for (const [i, change] of changes.entries()) {
			const element = nodes[i];
			const prototype =
				element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, change.after);
			element.dispatchEvent(new Event("input", { bubbles: true }));
			element.dispatchEvent(new Event("change", { bubbles: true }));
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Exactly one click, never a submit button or generic form submission.
		attempted = true;
		buttons[0].click();
		for (let i = 0; i < 2; i++) {
			await new Promise((resolve) => setTimeout(resolve, 750));
			const { answers: saved } = await persisted();
			if (changes.every((c) => saved[c.field] === c.after))
				return {
					ok: true,
					result: { ...snapshot, answers: saved, revision: await hash(saved), saved: true },
				};
		}
		return fail(
			"SAVE_UNVERIFIED",
			"YC's save could not be verified. Read again before retrying; a save may have occurred.",
		);
	} catch {
		return fail(
			attempted ? "SAVE_UNVERIFIED" : "VERIFICATION_FAILED",
			attempted
				? "YC's save could not be verified. Read before retrying; a save may have occurred."
				: "YC's page could not be verified. No save was attempted; check the approved tab.",
		);
	}
}
