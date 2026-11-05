import { openBrowserApprovalPage } from "@repo/browser-runtime/approval-page";
import type { BrowserApprovals } from "@repo/browser-runtime/browser-approvals";
import { afterEach, expect, it, vi } from "vitest";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});
async function fixture() {
	const approvals = {
		review: vi.fn(() => ({
			view: {
				provider: "Slack <script>",
				workspace: "https://fixture.slack.com",
				message: "Review",
				scopes: ["Read"],
				candidates: [
					{
						id: "candidate",
						profileLabel: "Chrome",
						identity: { workspace: "https://fixture.slack.com", userId: "user" },
					},
				],
				profiles: [],
			},
			capabilities: { candidate: "approve-secret" },
		})),
		approve: vi.fn(),
		cancel: vi.fn(),
		focus: vi.fn(),
	};
	const page = await openBrowserApprovalPage(
		approvals as unknown as BrowserApprovals,
		"request",
		"client",
	);
	cleanup.push(page.close);
	return { page, approvals };
}
it("serves escaped request-scoped HTML and refuses untrusted POSTs", async () => {
	const { page, approvals } = await fixture();
	const response = await fetch(page.url);
	const html = await response.text();
	expect(html).toContain("Slack &lt;script&gt;");
	expect(html).not.toContain("<script>");
	expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect((await fetch(new URL("/", page.url))).status).toBe(404);
	const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
	const body = new URLSearchParams({ csrf, action: "approve", capability: "approve-secret" });
	for (const origin of ["https://evil.example", "null"])
		expect((await fetch(page.url, { method: "POST", headers: { origin }, body })).status).toBe(400);
	expect(approvals.approve).not.toHaveBeenCalled();
	const accepted = await fetch(page.url, {
		method: "POST",
		headers: { origin: new URL(page.url).origin },
		body,
		redirect: "manual",
	});
	expect(accepted.status).toBe(303);
	expect(approvals.approve).toHaveBeenCalledWith("request", "client", "approve-secret");
});
it("does not accept cross-origin GET-triggered actions or missing CSRF", async () => {
	const { page, approvals } = await fixture();
	expect((await fetch(page.url + "?action=approve")).status).toBe(404);
	expect(
		(
			await fetch(page.url, {
				method: "POST",
				headers: { origin: new URL(page.url).origin },
				body: new URLSearchParams({ action: "approve", capability: "approve-secret" }),
			})
		).status,
	).toBe(400);
	expect(approvals.approve).not.toHaveBeenCalled();
});
