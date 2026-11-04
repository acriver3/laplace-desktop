import { beforeEach, describe, expect, it, vi } from "vitest";
const memory = vi.hoisted(() => ({ items: [] as any[], writes: 0 }));
vi.mock("electron", () => ({
	ClipboardItem: class {
		constructor(private data: Record<string, unknown>) {}
		get types() {
			return Object.keys(this.data);
		}
		async getType(type: string) {
			const value = this.data[type];
			return typeof value === "string" ? new Blob([value], { type }) : value;
		}
	},
	clipboard: {
		read: async () => memory.items,
		write: async (items: any[]) => {
			memory.items = items;
			memory.writes++;
		},
		readText: async () =>
			memory.items[0]?.getType("text/plain").then((value: Blob) => value.text()) ?? "",
	},
}));
import { clipboard, ClipboardItem } from "electron";

import { readChatTarget, verifyChatTarget, withPointClipboard } from "../src/point/clipboard";
import type { PointNative } from "../src/point/native";
beforeEach(async () => {
	memory.items = [new ClipboardItem({ "text/plain": "existing", "text/html": "<b>existing</b>" })];
	memory.writes = 0;
});
describe("Point clipboard lease", () => {
	it("restores all original formats after success and failure", async () => {
		const original = memory.items;
		await withPointClipboard(async (lease) => {
			await lease.text("point");
			expect(await clipboard.readText()).toBe("point");
		});
		expect(memory.items[0].types).toEqual(original[0].types);
		expect(await clipboard.readText()).toBe("existing");
		await expect(
			withPointClipboard(async (lease) => {
				await lease.image(Buffer.from("png"));
				throw new Error("interrupted");
			}),
		).rejects.toThrow("interrupted");
		expect(memory.items[0].types).toEqual(original[0].types);
		expect(await clipboard.readText()).toBe("existing");
	});
	it("does not overwrite clipboard changes made during handoff", async () => {
		await withPointClipboard(async (lease) => {
			await lease.text("point");
			await clipboard.write([new ClipboardItem({ "text/plain": "user copied this" })]);
		});
		expect(await clipboard.readText()).toBe("user copied this");
	});
	it("binds and verifies the copied existing-chat link, restoring the clipboard", async () => {
		const original = memory.items;
		const native = {
			call: vi.fn(async () => {
				await clipboard.write([
					new ClipboardItem({ "text/plain": "codex://threads/12345678-abcd" }),
				]);
			}),
		} as unknown as PointNative;
		const window = { window: "1", pid: 1, version: "test" };
		const target = await readChatTarget(native, window);
		expect(target.chatLink).toBe("codex://threads/12345678-abcd");
		expect(memory.items[0].types).toEqual(original[0].types);
		expect(await clipboard.readText()).toBe("existing");
		await expect(
			verifyChatTarget(native, { ...target, chatLink: "codex://threads/87654321" }),
		).rejects.toThrow("chat changed");
		expect(await clipboard.readText()).toBe("existing");
	});
});
