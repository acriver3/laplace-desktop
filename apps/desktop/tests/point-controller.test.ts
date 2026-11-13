import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	root: "",
	windows: [] as any[],
	handler: undefined as any,
	protocol: { handle: vi.fn(), unhandle: vi.fn() },
	frame: {
		isEmpty: () => false,
		getSize: () => ({ width: 200, height: 100 }),
		toDataURL: () => "data:image/png;base64,fixture",
		crop: vi.fn(),
	},
}));
vi.mock("electron", () => {
	const overlaySession = { protocol: fixture.protocol, setPermissionRequestHandler: vi.fn() };
	return {
		app: { getPath: () => fixture.root },
		BrowserWindow: class {
			listeners = new Map<string, Function[]>();
			destroyed = false;
			focused = false;
			webContents = {
				id: fixture.windows.length + 1,
				mainFrame: { url: "" },
				getURL: () => this.webContents.mainFrame.url,
				setWindowOpenHandler: vi.fn(),
				on: vi.fn(),
				session: overlaySession,
			};
			constructor(readonly options: unknown) {
				fixture.windows.push(this);
			}
			on(event: string, listener: Function) {
				this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
			}
			emit(event: string) {
				this.listeners.get(event)?.forEach((listener) => listener());
			}
			async loadURL(url: string) {
				this.webContents.mainFrame.url = url;
			}
			showInactive() {}
			setVisibleOnAllWorkspaces = vi.fn();
			focus() {
				this.focused = true;
			}
			isFocused() {
				return this.focused;
			}
			isDestroyed() {
				return this.destroyed;
			}
			destroy() {
				this.destroyed = true;
				this.focused = false;
				this.emit("closed");
			}
		},
		clipboard: {},
		ClipboardItem: class {},
		net: { fetch: vi.fn() },
		desktopCapturer: {
			getSources: vi.fn(async () => [{ display_id: "1", thumbnail: fixture.frame }]),
		},
		globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
		ipcMain: {
			handle: (_name: string, handler: unknown) => {
				fixture.handler = handler;
			},
			removeHandler: vi.fn(),
		},
		session: { fromPartition: vi.fn(() => overlaySession) },
		screen: {
			getAllDisplays: () => [
				{
					id: 1,
					scaleFactor: 2,
					size: { width: 100, height: 50 },
					bounds: { x: -100, y: -50, width: 100, height: 50 },
				},
			],
			getCursorScreenPoint: () => ({ x: -50, y: -25 }),
			getDisplayNearestPoint: () => ({ id: 1 }),
		},
		shell: {},
		systemPreferences: {
			getMediaAccessStatus: vi.fn(() => "granted"),
			isTrustedAccessibilityClient: vi.fn(() => true),
		},
	};
});
vi.mock("../src/point/clipboard", () => ({
	readChatTarget: vi.fn(async (_native, window) => ({
		...window,
		chatLink: "codex://threads/12345678",
	})),
	verifyChatTarget: vi.fn(),
	withPointClipboard: vi.fn(),
}));
vi.mock("../src/point/destinations", () => ({
	deliverToAgent: vi.fn(async () => "Paste your snip"),
}));
import { desktopCapturer } from "electron";

import { PointController } from "../src/main/point";
import { PointCaptures } from "../src/point/captures";
import { readChatTarget } from "../src/point/clipboard";
import { deliverToAgent } from "../src/point/destinations";
import { PointHandoff } from "../src/point/handoff";
import { PointNative } from "../src/point/native";

let controller: PointController;
const target = { window: "42", pid: 42, version: "fixture" };
beforeEach(async () => {
	vi.clearAllMocks();
	fixture.windows = [];
	fixture.root = await mkdtemp(join(tmpdir(), "point-controller-"));
	vi.spyOn(PointNative.prototype, "available").mockResolvedValue(true);
	vi.spyOn(PointNative.prototype, "permissions").mockResolvedValue({ accessibility: true });
	vi.spyOn(PointNative.prototype, "identify").mockResolvedValue(target);
	vi.spyOn(PointHandoff.prototype, "start").mockResolvedValue({
		status: "attachment-ready",
		message: "fixture",
	});
	fixture.frame.crop.mockImplementation((rect) => ({
		getSize: () => ({ width: rect.width, height: rect.height }),
		toPNG: () => Buffer.from("selected crop"),
	}));
	controller = new PointController({
		resources: fixture.root,
		appRoot: fixture.root,
		uiUrl: "laplace-desktop://app/index.html",
		changed: () => {},
		attention: () => {},
	});
	await controller.initialize();
	await controller.configure({ enabled: true, shortcut: "Control+L" });
});
afterEach(async () => {
	await controller?.stop();
	await rm(fixture.root, { recursive: true, force: true });
	vi.restoreAllMocks();
});
const eventFor = (window: any) => ({
	sender: window.webContents,
	senderFrame: window.webContents.mainFrame,
});

it("reports the helper permission and refreshes it after macOS settings change", async () => {
	vi.mocked(controller.native.permissions).mockResolvedValue({ accessibility: false });
	expect((await controller.status()).permissions.accessibility).toBe(false);
	vi.mocked(controller.native.permissions).mockResolvedValue({ accessibility: true });
	expect((await controller.status()).permissions.accessibility).toBe(true);
	vi.mocked(controller.native.permissions).mockRejectedValue(new Error("Helper unavailable"));
	expect((await controller.status()).permissions.accessibility).toBe(false);
});

it("registers the isolated overlay protocol and accepts selection before any Codex input", async () => {
	await controller.capture();
	await controller.capture();
	expect(fixture.protocol.handle).toHaveBeenCalledWith("laplace-desktop", expect.any(Function));
	expect(fixture.windows).toHaveLength(1);
	const window = fixture.windows[0];
	expect(window.options).toMatchObject({
		x: -100,
		y: -50,
		webPreferences: { partition: "laplace-point-overlay", sandbox: true },
	});
	expect(window.webContents.getURL()).toBe("laplace-desktop://app/point.html");
	expect(readChatTarget).not.toHaveBeenCalled();
	expect(controller.state.phase).toBe("capturing");
	await fixture.handler(eventFor(window), {
		action: "select",
		rect: { x: 10, y: 5, width: 20, height: 10 },
	});
	expect(fixture.frame.crop).toHaveBeenCalledWith({ x: 20, y: 10, width: 40, height: 20 });
	expect(readChatTarget).toHaveBeenCalledWith(controller.native, target);
	expect(controller.state.capture?.target?.window).toBe("42");
	expect(controller.state.phase).toBe("attachment-ready");
});
it("cancels on Escape or focus loss without touching Codex or saving full screens", async () => {
	await controller.capture();
	await fixture.handler(eventFor(fixture.windows[0]), { action: "cancel" });
	expect(controller.state.phase).toBe("idle");
	await controller.capture();
	const window = fixture.windows[1];
	window.focused = false;
	window.emit("blur");
	await new Promise((resolve) => setImmediate(resolve));
	expect(controller.state.phase).toBe("idle");
	expect(window.destroyed).toBe(true);
	expect(readChatTarget).not.toHaveBeenCalled();
	expect(controller.captures.items.size).toBe(0);
});
it("rejects overlay IPC from another frame or a destroyed capture window", async () => {
	await controller.capture();
	const window = fixture.windows[0];
	await expect(
		fixture.handler(
			{ ...eventFor(window), senderFrame: { url: window.webContents.getURL() } },
			{ action: "cancel" },
		),
	).rejects.toThrow("Unauthorized");
	controller.cancelCapture();
	await expect(
		fixture.handler(eventFor(window), {
			action: "select",
			rect: { x: 0, y: 0, width: 10, height: 10 },
		}),
	).rejects.toThrow("Unauthorized");
});

it("preserves the native permission error after saving a snip instead of replacing it with Retry snip", async () => {
	vi.mocked(controller.native.identify).mockRejectedValue(
		new Error("Allow Laplace in Accessibility, then retry."),
	);
	await controller.capture();
	await fixture.handler(eventFor(fixture.windows[0]), {
		action: "select",
		rect: { x: 0, y: 0, width: 10, height: 10 },
	});
	expect(controller.state.phase).toBe("needs-attention");
	expect(controller.state.message).toBe("Allow Laplace in Accessibility, then retry.");
	expect(controller.state.capture).toBeDefined();
	expect(PointHandoff.prototype.start).not.toHaveBeenCalled();
});
it("rechecks an unavailable Codex destination after selection without requiring a trip to settings", async () => {
	vi.mocked(controller.native.identify)
		.mockRejectedValueOnce(new Error("Codex is unavailable"))
		.mockResolvedValue(target);
	await controller.capture();
	await fixture.handler(eventFor(fixture.windows[0]), {
		action: "select",
		rect: { x: 0, y: 0, width: 10, height: 10 },
	});
	expect(controller.state.phase).toBe("attachment-ready");
	expect(controller.state.capture?.target?.window).toBe("42");
});
it("routes browser snips without Codex and pins the saved destination across configuration changes", async () => {
	await controller.configure({
		enabled: true,
		shortcut: "Control+L",
		destination: "claude-browser",
	});
	await controller.capture();
	expect(controller.native.identify).not.toHaveBeenCalled();
	await fixture.handler(eventFor(fixture.windows[0]), {
		action: "select",
		rect: { x: 0, y: 0, width: 10, height: 10 },
	});
	expect(controller.state.phase).toBe("ready-to-paste");
	expect(deliverToAgent).toHaveBeenLastCalledWith(
		"claude-browser",
		expect.any(Buffer),
		expect.stringMatching(/\.png$/),
	);
	await controller.configure({
		enabled: true,
		shortcut: "Control+L",
		destination: "chatgpt-browser",
	});
	await controller.retry();
	expect(deliverToAgent).toHaveBeenLastCalledWith(
		"claude-browser",
		expect.any(Buffer),
		expect.any(String),
	);
	const stored = new PointCaptures(controller.captures.root);
	await stored.initialize();
	expect([...stored.items.values()][0].destination).toBe("claude-browser");
});

it("explains screen recording failures instead of reporting a handoff failure", async () => {
	vi.mocked(desktopCapturer.getSources).mockRejectedValueOnce("Failed to get sources.");
	await controller.capture();
	expect(controller.state.message).toContain("Screen & System Audio Recording");
	expect(controller.state.message).toContain("Failed to get sources.");
	expect(controller.state.capture).toBeUndefined();
	expect(fixture.windows).toHaveLength(0);
});

it("only counts an active snip or handoff as update activity, not a retained snip", async () => {
	await controller.configure({
		enabled: true,
		shortcut: "Control+L",
		destination: "claude-browser",
	});
	expect(controller.activeForUpdates()).toBe(false);
	await controller.capture();
	expect(controller.activeForUpdates()).toBe(true);
	await fixture.handler(eventFor(fixture.windows[0]), {
		action: "select",
		rect: { x: 0, y: 0, width: 10, height: 10 },
	});
	expect(controller.state.phase).toBe("ready-to-paste");
	expect(controller.state.capture).toBeDefined();
	expect(controller.activeForUpdates()).toBe(false);
	// After a restart the last snip is retained for retry; that alone must not defer updates.
	await controller.stop();
	controller = new PointController({
		resources: fixture.root,
		appRoot: fixture.root,
		uiUrl: "laplace-desktop://app/index.html",
		changed: () => {},
		attention: () => {},
	});
	await controller.initialize();
	expect(controller.state.capture).toBeDefined();
	expect(controller.activeForUpdates()).toBe(false);
});
