import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PointCaptures, retentionMs } from "../src/point/captures";
import { annotationQualification, type PointQualification } from "../src/point/compatibility";
import { PointHandoff, type PointHandoffDriver } from "../src/point/handoff";
import type { NativeObservation } from "../src/point/native";
import { PointServer } from "../src/point/server";
import {
	pixelCrop,
	pointChatLink,
	pointSettings,
	type PointCapture,
} from "../src/shared/point-contracts";
import { shellRequest } from "../src/shared/shell-contracts";

const roots: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
	const root = await mkdtemp(join(tmpdir(), "laplace-point-"));
	roots.push(root);
	return root;
}
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQImWP4z8DwH4QZGBgYGMAAAAD//wMAJ+8F/f0DGTQAAAAASUVORK5CYII=",
	"base64",
);

describe("Point capture contracts", () => {
	it("maps local DIPs using actual raster dimensions, including fractional DPI", () => {
		expect(
			pixelCrop(
				{ x: 10, y: 20, width: 100, height: 50 },
				{ width: 1920, height: 1080 },
				{ width: 2400, height: 1350 },
			),
		).toEqual({ x: 12, y: 25, width: 126, height: 63 });
		expect(
			pixelCrop(
				{ x: 0, y: 0, width: 1512, height: 982 },
				{ width: 1512, height: 982 },
				{ width: 3024, height: 1964 },
			),
		).toEqual({ x: 0, y: 0, width: 3024, height: 1964 });
	});
	it("rejects out-of-screen, invalid and accidental tiny selections", () => {
		for (const rect of [
			{ x: -1, y: 0, width: 10, height: 10 },
			{ x: 99, y: 0, width: 2, height: 10 },
			{ x: 0, y: 0, width: NaN, height: 10 },
			{ x: 0, y: 0, width: 0.1, height: 0.1 },
		])
			expect(() =>
				pixelCrop(rect, { width: 100, height: 100 }, { width: 100, height: 100 }),
			).toThrow();
	});
	it("accepts bounded settings and local existing-chat links only", () => {
		expect(pointSettings.parse({ enabled: true, shortcut: "Ctrl+Shift+L" }).enabled).toBe(true);
		for (const shortcut of ["L", "Control+L;exit", "Control+Enter", "Control+L+X"])
			expect(pointSettings.safeParse({ enabled: true, shortcut }).success).toBe(false);
		expect(pointChatLink(" codex://threads/12345678-abcd ")).toBe("codex://threads/12345678-abcd");
		for (const link of [
			"codex://threads/new",
			"https://example.com",
			"codex://threads/12345678?prompt=send",
			"codex://threads/../../new",
		])
			expect(pointChatLink(link)).toBeUndefined();
		expect(
			shellRequest.safeParse({
				method: "shell.point.capture",
				input: { url: "https://example.com" },
			}).success,
		).toBe(false);
	});
});

describe("Point storage and local server", () => {
	it("retains only cropped assets for seven days, reloads records and clears them", async () => {
		let now = 1000000000;
		const root = await temporary();
		const captures = new PointCaptures(root, () => now);
		await captures.initialize();
		const item = await captures.save(png, { width: 2, height: 2 });
		const reload = new PointCaptures(root, () => now);
		await reload.initialize();
		expect(reload.byToken(item.token)?.id).toBe(item.id);
		expect(await reload.read(item)).toEqual(png);
		now += retentionMs;
		await reload.prune();
		expect(reload.items.size).toBe(0);
		await expect(readFile(captures.file(item.id))).rejects.toThrow();
		await reload.save(png, { width: 2, height: 2 });
		await reload.prune(true);
		expect(reload.items.size).toBe(0);
	});
	it("does not follow a replacement image symlink", async () => {
		if (process.platform === "win32") return; // Windows symlink creation may require a separate OS privilege.
		const root = await temporary();
		const captures = new PointCaptures(join(root, "captures"));
		await captures.initialize();
		const item = await captures.save(png, { width: 2, height: 2 });
		const outside = join(root, "outside");
		await writeFile(outside, "private");
		await rm(captures.file(item.id));
		await symlink(outside, captures.file(item.id));
		await expect(captures.read(item)).rejects.toThrow();
	});
	it("requires exact hosts and capability routes, and accepts only bounded same-origin status", async () => {
		const captures = new PointCaptures(await temporary());
		await captures.initialize();
		const item = await captures.save(png, { width: 2, height: 2 });
		const server = new PointServer(captures);
		await server.start();
		try {
			const page = await fetch(server.url(item));
			expect(page.status).toBe(200);
			expect(page.headers.get("cache-control")).toBe("no-store");
			expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
			expect(await page.text()).toContain("Annotate this snip");
			expect(
				Buffer.from(await (await fetch(server.url(item) + "image.png")).arrayBuffer()),
			).toEqual(png);
			expect((await fetch(server.origin + "/capture/" + "0".repeat(64) + "/")).status).toBe(404);
			expect(
				(await fetch(server.url(item), { headers: { Origin: "https://evil.example" } })).status,
			).toBe(403);
			const badHost = await new Promise<number>((resolve, reject) => {
				const req = request(server.url(item), { headers: { Host: "evil.example" } }, (res) => {
					res.resume();
					resolve(res.statusCode!);
				});
				req.on("error", reject);
				req.end();
			});
			expect(badHost).toBe(403);
			expect(
				(
					await fetch(server.url(item) + "status", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: '{"state":"ready"}',
					})
				).status,
			).toBe(403);
			expect(
				(
					await fetch(server.url(item) + "status", {
						method: "POST",
						headers: { "Content-Type": "application/json", Origin: server.origin },
						body: '{"state":"requested"}',
					})
				).status,
			).toBe(204);
			expect(server.state(item)).toBe("requested");
			expect(
				(
					await fetch(server.url(item) + "status", {
						method: "POST",
						headers: { "Content-Type": "application/json", Origin: server.origin },
						body: '{"state":"draft-ready"}',
					})
				).status,
			).toBe(400);
			await captures.prune(true);
			expect((await fetch(server.url(item))).status).toBe(404);
		} finally {
			await server.stop();
		}
	});
});

const qualified: PointQualification = {
	platform: "fixture",
	arch: "fixture",
	version: "fixture",
	annotationDraft: true,
	annotationImageDurable: true,
	evidence: "fixture",
};
function harness(qualification?: PointQualification) {
	const capture: PointCapture = {
		id: "fixture",
		createdAt: 1,
		width: 2,
		height: 2,
		target: { window: "1", pid: 2, version: "fixture", chatLink: "codex://threads/12345678" },
	};
	const observed: NativeObservation = {
		composer: true,
		editor: false,
		attachments: 2,
		annotations: 1,
		stage: false,
	};
	const driver: PointHandoffDriver = {
		verify: vi.fn(async () => {}),
		observe: vi.fn(async () => ({ ...observed })),
		open: vi.fn(async () => "ready" as const),
		annotate: vi.fn(async () => {
			observed.editor = true;
		}),
		attach: vi.fn(async () => {
			observed.attachments++;
		}),
		stage: vi.fn(async () => {
			observed.annotations++;
			observed.stage = false;
		}),
		focusComposer: vi.fn(async () => {}),
		markAttachmentAttempted: vi.fn(async () => {}),
		markAnnotationAttempted: vi.fn(async () => {}),
		focusEditor: vi.fn(async () => {}),
	};
	return { capture, observed, driver, handoff: new PointHandoff(driver, capture, qualification) };
}
describe("Point draft handoff", () => {
	it("uses attachments on unqualified builds and preserves existing context", async () => {
		const h = harness();
		expect((await h.handoff.start()).status).toBe("attachment-ready");
		expect(h.observed.attachments).toBe(3);
		expect(h.observed.annotations).toBe(1);
		expect(h.driver.open).not.toHaveBeenCalled();
		expect(h.driver.markAttachmentAttempted).toHaveBeenCalledOnce();
		expect(annotationQualification("unverified-build")).toBeUndefined();
	});
	it("waits for the actual editor, then stages saved context without a send operation", async () => {
		const h = harness(qualified);
		expect((await h.handoff.start()).status).toBe("editor-ready");
		expect(h.driver.focusEditor).toHaveBeenCalledOnce();
		expect(await h.handoff.checkSaved()).toBeUndefined();
		expect(h.driver.stage).not.toHaveBeenCalled();
		h.observed.editor = false;
		h.observed.stage = true;
		expect((await h.handoff.checkSaved())?.status).toBe("draft-ready");
		expect(h.driver.stage).toHaveBeenCalledOnce();
		expect(await h.handoff.checkSaved()).toBeUndefined();
		expect(h.driver.attach).not.toHaveBeenCalled();
	});
	it("attaches the original when native annotation images are not durable", async () => {
		const h = harness({ ...qualified, annotationImageDurable: false });
		await h.handoff.start();
		h.observed.editor = false;
		h.observed.annotations++;
		expect((await h.handoff.checkSaved())?.status).toBe("draft-ready");
		expect(h.driver.attach).toHaveBeenCalledOnce();
	});
	it("waits for a site-permission decision and the real editor before focusing", async () => {
		vi.useFakeTimers();
		const h = harness(qualified);
		h.driver.permissionRequired = vi.fn();
		vi.mocked(h.driver.annotate).mockImplementation(async () => {
			h.observed.permission = true;
		});
		const pending = h.handoff.start();
		await vi.advanceTimersByTimeAsync(8000);
		expect(h.driver.permissionRequired).toHaveBeenCalledOnce();
		expect(h.driver.focusEditor).not.toHaveBeenCalled();
		expect(h.driver.attach).not.toHaveBeenCalled();
		h.observed.permission = false;
		await vi.advanceTimersByTimeAsync(200);
		expect(h.driver.focusEditor).not.toHaveBeenCalled();
		h.observed.editor = true;
		await vi.advanceTimersByTimeAsync(200);
		expect((await pending).status).toBe("editor-ready");
	});
	it("does not insert a screenshot when site permission is denied", async () => {
		vi.useFakeTimers();
		const h = harness(qualified);
		vi.mocked(h.driver.annotate).mockImplementation(async () => {
			h.observed.permission = true;
		});
		const pending = expect(h.handoff.start()).rejects.toThrow("did not allow");
		await vi.advanceTimersByTimeAsync(200);
		h.observed.permission = false;
		await vi.advanceTimersByTimeAsync(3500);
		await pending;
		expect(h.driver.attach).not.toHaveBeenCalled();
	});
	it("allows the saved draft chip to appear after the popup closes", async () => {
		const h = harness(qualified);
		await h.handoff.start();
		h.observed.editor = false;
		expect(await h.handoff.checkSaved()).toBeUndefined();
		h.observed.annotations++;
		expect((await h.handoff.checkSaved())?.status).toBe("draft-ready");
		expect(h.driver.attach).not.toHaveBeenCalled();
	});
	it("retains a cancelled annotation without attaching or claiming draft success", async () => {
		vi.useFakeTimers();
		const h = harness(qualified);
		await h.handoff.start();
		h.observed.editor = false;
		expect(await h.handoff.checkSaved()).toBeUndefined();
		await vi.advanceTimersByTimeAsync(3100);
		expect((await h.handoff.checkSaved())?.status).toBe("needs-attention");
		expect(h.driver.attach).not.toHaveBeenCalled();
	});
	it("does not mutate another chat or an already open annotation", async () => {
		const h = harness();
		vi.mocked(h.driver.verify).mockRejectedValue(new Error("chat changed"));
		await expect(h.handoff.start()).rejects.toThrow("chat changed");
		expect(h.driver.attach).not.toHaveBeenCalled();
		const busy = harness(qualified);
		busy.observed.editor = true;
		await expect(busy.handoff.start()).rejects.toThrow("existing Codex annotation");
		expect(busy.driver.open).not.toHaveBeenCalled();
	});
	it("does not replay an uncertain paste after a failure or reconstructed session", async () => {
		const h = harness();
		vi.mocked(h.driver.attach).mockRejectedValue(new Error("lost connection"));
		await expect(h.handoff.start()).rejects.toThrow("lost connection");
		expect(h.capture.attachmentAttempted).toBe(true);
		await expect(new PointHandoff(h.driver, h.capture).start()).rejects.toThrow("may already be");
		expect(h.driver.attach).toHaveBeenCalledOnce();
	});
	it("retains a retryable snip when composer focus fails before any paste", async () => {
		const h = harness();
		vi.mocked(h.driver.focusComposer).mockRejectedValueOnce(
			new Error("focus could not be verified"),
		);
		await expect(h.handoff.start()).rejects.toThrow("focus could not be verified");
		expect(h.capture.attachmentAttempted).toBeUndefined();
		expect(h.driver.attach).not.toHaveBeenCalled();
		expect((await new PointHandoff(h.driver, h.capture).start()).status).toBe("attachment-ready");
		expect(h.driver.attach).toHaveBeenCalledOnce();
	});
	it("does not treat an API acceptance or missing attachment as success", async () => {
		vi.useFakeTimers();
		const h = harness(qualified);
		vi.mocked(h.driver.annotate).mockResolvedValue();
		const pending = expect(h.handoff.start()).rejects.toThrow("expected control");
		await vi.advanceTimersByTimeAsync(4500);
		await pending;
	});
});
