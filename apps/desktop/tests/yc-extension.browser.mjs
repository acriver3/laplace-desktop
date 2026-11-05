import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium } from "@playwright/test";

import { ycAction } from "../../../packages/browser-runtime/extension/ycombinator.js";

void test(
	"approved-tab YC flow reads, previews, saves once, verifies persistence and rejects conflicts",
	{ skip: !process.argv[2] },
	async () => {
		const browser = await chromium.launch({ executablePath: process.argv[2] });
		try {
			const page = await browser.newPage();
			const id = "12345678-1234-4234-8234-123456789abc",
				origin = "https://apply.ycombinator.com";
			let saved = "Original",
				writes = 0,
				submits = 0,
				persistWrites = true;
			const html =
				() => `<span>demo</span><a title="Account Settings" href="https://account.ycombinator.com">settings</a><button>Log out</button>
			<div id="f_company"><div class="apply-section-header">Company</div><div id="name"><label>Company name</label><p>Use your company name.</p><div><input maxlength="80" type="text" name="name" value="${saved}"></div></div></div><input type="checkbox" name="stage" checked>
			<button onclick="fetch('/apps/${id}', {method:'POST',body:JSON.stringify({name:document.querySelector('[name=name]').value})})">Save changes</button>
			<button onclick="fetch('/submit',{method:'POST'})">Submit application</button>`;
			await page.route(origin + "/**", async (route) => {
				if (route.request().method() === "POST") {
					if (new URL(route.request().url()).pathname === "/submit") submits++;
					else {
						writes++;
						if (persistWrites) saved = JSON.parse(route.request().postData()).name;
					}
					await route.fulfill({ json: { ok: true } });
				} else
					await route.fulfill({
						contentType: "text/html",
						body: `<div id="root"></div><script>setTimeout(() => { document.getElementById('root').innerHTML = ${JSON.stringify(html())}; }, 100);</script>`,
					});
			});
			await page.goto(`${origin}/apps/${id}/edit`);
			await page.getByRole("button", { name: "Save changes", exact: true }).waitFor();
			const invoke = (method, args, expected = { workspace: origin, userId: "demo" }) =>
				page.evaluate(
					async ({ source, method, args, expected, origin }) =>
						(0, eval)(`(${source})`)(method, args, expected, origin),
					{ source: ycAction.toString(), method, args, expected, origin },
				);
			assert.equal((await invoke("account.identify", {}, null)).result.userId, "demo");
			assert.equal(
				(
					await invoke(
						"application.read",
						{ applicationId: id },
						{ workspace: origin, userId: "other" },
					)
				).error,
				"identity_mismatch",
			);
			const read = (await invoke("application.read", { applicationId: id })).result;
			assert.equal(read.answers.name, "Original");
			assert.equal(read.questions[0].label, "Company name");
			assert.equal(read.questions[0].section, "Company");
			assert.equal(read.questions[0].helpText, "Use your company name.");
			assert.equal(read.questions[0].maxLength, 80);
			assert.equal(read.questions[0].editable, true);
			await page.locator('[name="name"]').fill("Manual unsaved draft");
			assert.equal(
				(await invoke("application.read", { applicationId: id })).result.answers.name,
				"Original",
			);
			await page.locator('[name="name"]').fill("Original");
			const input = {
				applicationId: id,
				expectedRevision: read.revision,
				changes: { name: "Updated" },
			};
			assert.equal((await invoke("application.saveDraft", input)).result.preview, true);
			assert.equal(writes, 0);
			await page.locator('[name="stage"]').uncheck();
			assert.equal(
				(await invoke("application.saveDraft", { ...input, confirm: true })).result.error.code,
				"UNSAVED_CHANGES",
			);
			assert.equal(writes, 0);
			await page.locator('[name="stage"]').check();
			const result = await invoke("application.saveDraft", { ...input, confirm: true });
			assert.equal(result.result.saved, true, JSON.stringify(result));
			assert.equal(result.result.answers.name, "Updated");
			assert.equal(writes, 1);
			assert.equal(submits, 0);
			assert.equal(
				(await invoke("application.saveDraft", { ...input, confirm: true })).result.error.code,
				"CONFLICT",
			);
			assert.equal(
				(
					await invoke("application.saveDraft", {
						...input,
						expectedRevision: result.result.revision,
						changes: { submit: "true" },
						confirm: true,
					})
				).result.error.code,
				"INVALID_FIELD",
			);
			assert.equal(writes, 1);
			persistWrites = false;
			const uncertain = await invoke("application.saveDraft", {
				applicationId: id,
				expectedRevision: result.result.revision,
				changes: { name: "Not persisted" },
				confirm: true,
			});
			assert.equal(uncertain.result.error.code, "SAVE_UNVERIFIED");
			assert.equal(writes, 2);
			assert.equal(
				(await invoke("application.read", { applicationId: id })).result.answers.name,
				"Updated",
			);
			assert.equal(writes, 2);
		} finally {
			await browser.close();
		}
	},
);
