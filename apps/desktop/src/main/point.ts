import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

import {
	app,
	BrowserWindow,
	clipboard,
	ClipboardItem,
	desktopCapturer,
	globalShortcut,
	ipcMain,
	screen,
	session,
	shell,
	systemPreferences,
	type NativeImage,
} from "electron";
import { z } from "zod";

import { PointCaptures, type StoredCapture } from "../point/captures";
import { readChatTarget, verifyChatTarget, withPointClipboard } from "../point/clipboard";
import { annotationQualification } from "../point/compatibility";
import { deliverToAgent } from "../point/destinations";
import { PointHandoff, waitFor } from "../point/handoff";
import { PointNative, type NativeWindow } from "../point/native";
import { PointServer } from "../point/server";
import {
	defaultPointSettings,
	pointDestinationLabels,
	pixelCrop,
	pointRect,
	pointSettings,
	type PointSettingsInput,
	type PointState,
	type PointTarget,
} from "../shared/point-contracts";
import { registerRendererProtocol } from "./renderer-protocol";

const overlayRequest = z.discriminatedUnion("action", [
	z.object({ action: z.literal("initialize") }).strict(),
	z.object({ action: z.literal("cancel") }).strict(),
	z.object({ action: z.literal("select"), rect: pointRect }).strict(),
]);
type FrozenDisplay = { display: Electron.Display; image: NativeImage; window: BrowserWindow };

export class PointController {
	state: PointState = {
		settings: { ...defaultPointSettings },
		available: false,
		registered: false,
		phase: "idle",
		permissions: { screen: "unknown", accessibility: false },
	};
	readonly captures: PointCaptures;
	readonly server: PointServer;
	readonly native: PointNative;
	private readonly root: string;
	private overlays = new Map<number, FrozenDisplay>();
	private target?: PointTarget;
	private captureWindow?: NativeWindow;
	private captureTargetError?: Error;
	private selectionVisible = false;
	private current?: StoredCapture;
	private handoff?: PointHandoff;
	private busy = false;
	private stopping = false;
	private monitor?: ReturnType<typeof setInterval>;
	private cleanup?: ReturnType<typeof setInterval>;
	private monitoring = false;
	private suspended = 0;
	private captureGeneration = 0;
	private cancelled = false;
	constructor(
		private readonly options: {
			resources: string;
			appRoot: string;
			uiUrl: string;
			changed(state: PointState): void;
			attention(): void;
		},
	) {
		this.root = join(app.getPath("userData"), "point");
		this.captures = new PointCaptures(join(this.root, "captures"));
		this.server = new PointServer(this.captures);
		this.native = new PointNative(options.resources);
	}
	private publish() {
		this.options.changed(this.state);
	}
	private permissions() {
		this.state.permissions = {
			screen:
				process.platform === "darwin"
					? systemPreferences.getMediaAccessStatus("screen")
					: "granted",
			accessibility:
				process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(false),
		};
	}
	async initialize() {
		await this.captures.initialize();
		this.current = [...this.captures.items.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
		if (this.current) {
			this.state.capture = this.publicCapture(this.current);
			this.state.message = "Your last snip is retained. Check the Codex draft before retrying.";
		}
		try {
			this.state.settings = pointSettings.parse(
				JSON.parse(await readFile(join(this.root, "settings.json"), "utf8")),
			);
		} catch {
			/* Safe disabled default on absent/invalid settings. */
		}
		this.state.available = await this.native.available();
		this.permissions();
		const overlaySession = session.fromPartition("laplace-point-overlay");
		registerRendererProtocol(overlaySession, this.options.appRoot);
		overlaySession.setPermissionRequestHandler((_contents, _permission, callback) =>
			callback(false),
		);
		await this.server.start();
		ipcMain.handle("laplace:point-overlay", async (event, raw: unknown) => {
			const frozen = this.overlays.get(event.sender.id);
			if (
				!frozen ||
				event.senderFrame !== event.sender.mainFrame ||
				event.senderFrame.url !== frozen.window.webContents.getURL()
			)
				throw new Error("Unauthorized Point capture request.");
			const request = overlayRequest.parse(raw);
			if (request.action === "initialize")
				return {
					image: frozen.image.toDataURL(),
					destination: pointDestinationLabels[this.state.settings.destination],
				};
			if (request.action === "cancel") {
				this.cancelCapture();
				return;
			}
			const rect = pixelCrop(request.rect, frozen.display.bounds, frozen.image.getSize());
			const image = frozen.image.crop(rect);
			const png = image.toPNG();
			const size = image.getSize();
			const captureWindow = this.captureWindow;
			this.closeOverlays();
			this.state.phase = "opening";
			this.publish();
			try {
				this.current = await this.captures.save(png, size);
				this.current.destination = this.state.settings.destination;
				await this.captures.update(this.current);
				this.state.capture = this.publicCapture(this.current);
				// Native keyboard input starts only after selection and durable crop storage.
				// Keep the window chosen at capture start; never choose a different one here.
				if (captureWindow) {
					this.target = await this.input(() => readChatTarget(this.native, captureWindow));
					this.current.target = this.target;
					await this.captures.update(this.current);
				}
				await this.deliver();
			} catch (error) {
				this.fail(error);
			} finally {
				this.busy = false;
			}
		});
		this.register();
		this.cleanup = setInterval(
			() => {
				void this.captures.prune().catch(() => {});
			},
			60 * 60 * 1000,
		);
		this.cleanup.unref();
		this.publish();
	}
	private publicCapture(item: StoredCapture) {
		const { token: _token, ...capture } = item;
		return capture;
	}
	private register() {
		this.state.registered = false;
		if (this.stopping || this.suspended || !this.state.settings.enabled || !this.state.available)
			return;
		try {
			this.state.registered = globalShortcut.register(this.state.settings.shortcut, () => {
				void this.capture();
			});
		} catch {
			this.state.registered = false;
		}
		if (!this.state.registered)
			this.state.message =
				"That shortcut is unavailable. Choose another shortcut or capture from the tray.";
	}
	private async input<T>(work: () => Promise<T>) {
		if (this.stopping || this.cancelled)
			throw new Error("Point handoff was cancelled. Your snip is retained.");
		this.suspended++;
		if (this.state.registered) globalShortcut.unregister(this.state.settings.shortcut);
		this.state.registered = false;
		try {
			return await work();
		} finally {
			this.suspended--;
			if (!this.suspended) this.register();
			this.publish();
		}
	}
	async configure(raw: PointSettingsInput) {
		if (this.busy || this.monitor)
			throw new Error("Finish or cancel the current snip before changing Point settings.");
		const settings = pointSettings.parse(raw);
		if (this.state.registered) globalShortcut.unregister(this.state.settings.shortcut);
		this.state.settings = settings;
		this.state.message = undefined;
		this.permissions();
		this.register();
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await writeFile(join(this.root, "settings.json.tmp"), JSON.stringify(settings), {
			mode: 0o600,
		});
		await rename(join(this.root, "settings.json.tmp"), join(this.root, "settings.json"));
		this.publish();
		return this.state;
	}
	async capture() {
		if (this.busy || this.monitor || this.stopping) return;
		if (!this.state.settings.enabled) {
			this.fail(new Error("Enable Laplace Point in Device settings first."));
			return;
		}
		if (!this.state.available) {
			this.fail(
				new Error(
					"This build does not contain the Point native adapter. Install a Windows or macOS Desktop package.",
				),
			);
			return;
		}
		this.busy = true;
		const generation = ++this.captureGeneration;
		this.cancelled = false;
		this.current = undefined;
		this.target = undefined;
		this.captureWindow = undefined;
		this.captureTargetError = undefined;
		this.state.capture = undefined;
		this.state.phase = "capturing";
		this.state.message = undefined;
		this.publish();
		try {
			this.permissions();
			const displays = screen.getAllDisplays();
			const sources = await desktopCapturer
				.getSources({
					types: ["screen"],
					thumbnailSize: {
						width: Math.max(...displays.map((d) => Math.ceil(d.size.width * d.scaleFactor))),
						height: Math.max(...displays.map((d) => Math.ceil(d.size.height * d.scaleFactor))),
					},
					fetchWindowIcons: false,
				})
				.catch((error: unknown) => {
					throw new Error(
						`Screen capture failed. Allow Laplace in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Laplace. ${pointError(error, "").message}`.trim(),
					);
				});
			const frames = displays.map((display) => {
				const source = sources.find((s) => s.display_id === String(display.id));
				if (!source || source.thumbnail.isEmpty())
					throw new Error(
						"Screen capture is unavailable. Check Screen Recording permission in system settings.",
					);
				return { display, image: source.thumbnail };
			});
			// Identification is read-only and never activates Codex or writes the clipboard.
			// Resolve the chat link after cropping, so selection is never interrupted by input.
			if (this.state.settings.destination === "codex-desktop") {
				try {
					this.captureWindow = await this.native.identify();
				} catch (error) {
					this.captureTargetError = pointError(error, "Codex is unavailable.");
					this.state.message = this.captureTargetError.message;
				}
			}
			if (generation !== this.captureGeneration || this.stopping) return;
			for (const frame of frames) {
				const overlay = new BrowserWindow({
					...frame.display.bounds,
					frame: false,
					transparent: false,
					backgroundColor: "#111111",
					show: false,
					movable: false,
					resizable: false,
					skipTaskbar: true,
					alwaysOnTop: true,
					hasShadow: false,
					enableLargerThanScreen: true,
					webPreferences: {
						preload: join(this.options.appRoot, "main/point-preload.cjs"),
						sandbox: true,
						contextIsolation: true,
						nodeIntegration: false,
						webSecurity: true,
						partition: "laplace-point-overlay",
					},
				});
				const id = overlay.webContents.id;
				this.overlays.set(id, { ...frame, window: overlay });
				overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
				overlay.webContents.on("will-navigate", (event) => event.preventDefault());
				overlay.webContents.on("will-redirect", (event) => event.preventDefault());
				overlay.on("blur", () => {
					setImmediate(() => {
						if (
							this.selectionVisible &&
							![...this.overlays.values()].some(({ window }) => window.isFocused())
						)
							this.cancelCapture();
					});
				});
				overlay.on("closed", () => {
					if (this.overlays.has(id)) this.cancelCapture();
				});
				if (process.platform === "darwin")
					overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
				await overlay.loadURL(new URL("point.html", this.options.uiUrl).href);
			}
			if (generation !== this.captureGeneration || this.stopping) {
				this.closeOverlays();
				return;
			}
			for (const frozen of this.overlays.values()) frozen.window.showInactive();
			const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
			[...this.overlays.values()].find((entry) => entry.display.id === display.id)?.window.focus();
			this.selectionVisible = true;
		} catch (error) {
			this.closeOverlays();
			this.busy = false;
			this.fail(error);
		}
	}
	private closeOverlays() {
		this.selectionVisible = false;
		const windows = [...this.overlays.values()];
		this.overlays.clear();
		for (const { window } of windows) if (!window.isDestroyed()) window.destroy();
	}
	cancelCapture() {
		this.cancelled = true;
		this.captureGeneration++;
		this.closeOverlays();
		this.busy = false;
		this.state.phase = "idle";
		this.publish();
	}
	private async deliver() {
		const item = this.current;
		if (!item) throw new Error("No snip is available.");
		if (this.cancelled || this.stopping)
			throw new Error("Point handoff was cancelled. Your snip is retained.");
		if (item.destination && item.destination !== "codex-desktop") {
			this.state.phase = "ready-to-paste";
			this.state.message = await deliverToAgent(
				item.destination,
				await this.captures.read(item),
				this.captures.file(item.id),
			);
			this.state.capture = this.publicCapture(item);
			this.publish();
			return;
		}
		if (!item.target) {
			// Recheck after selection: an app may have opened while the overlay was active.
			try {
				item.target = await this.input(async () =>
					readChatTarget(this.native, await this.native.identify()),
				);
				await this.captures.update(item);
			} catch (error) {
				throw pointError(
					error,
					this.captureTargetError?.message ?? "Open your Codex chat, then retry the retained snip.",
				);
			}
		}
		this.handoff = new PointHandoff(
			{
				verify: (target) => this.input(() => verifyChatTarget(this.native, target)),
				observe: (target) => this.native.observe(target),
				open: (target) =>
					this.input(async () => {
						this.server.reset(item);
						await this.native.call("open-tab", target);
						return withPointClipboard(async (lease) => {
							await lease.text(this.server.url(item));
							await this.native.call("navigate", target);
							const state = await waitFor(
								async () => this.server.state(item),
								(state) => !!state,
								5000,
							);
							return state === "ready" ? "ready" : "unsupported";
						});
					}),
				annotate: (target) =>
					this.input(async () => {
						await this.native.call("annotate", target);
					}),
				stage: (target) =>
					this.input(async () => {
						await this.native.call("stage", target);
					}),
				focusComposer: (target) =>
					this.input(async () => {
						await this.native.call("focus-composer", target);
					}),
				focusEditor: (target) =>
					this.input(async () => {
						await this.native.call("focus-annotation", target);
					}),
				markAttachmentAttempted: () => this.captures.update(item),
				markAnnotationAttempted: () => this.captures.update(item),
				permissionRequired: () => {
					this.state.message =
						"In Codex, allow this local snip page to start annotation mode. Then type your comment and choose Add.";
					this.publish();
				},
				attach: (target) =>
					this.input(() =>
						withPointClipboard(async (lease) => {
							const before = await this.native.observe(target);
							await lease.image(await this.captures.read(item));
							await this.native.call("paste-image", target);
							// Keep the image clipboard alive until the attachment actually appears.
							await waitFor(
								() => this.native.observe(target),
								(state) => state.attachments === before.attachments + 1,
							);
						}),
					),
			},
			item,
			annotationQualification(item.target.version),
		);
		const result = await this.handoff.start();
		if (result.status === "attachment-ready" || result.status === "draft-ready") {
			item.handoffComplete = true;
			await this.captures.update(item);
		}
		this.state.phase = result.status;
		this.state.message = result.message;
		this.state.capture = this.publicCapture(item);
		this.publish();
		if (result.status === "editor-ready") this.watchEditor();
	}
	private watchEditor() {
		clearInterval(this.monitor);
		this.monitor = setInterval(() => {
			if (this.monitoring || this.stopping) return;
			this.monitoring = true;
			void this.handoff
				?.checkSaved()
				.then(async (result) => {
					if (!result) return;
					clearInterval(this.monitor);
					this.monitor = undefined;
					if (result.status === "draft-ready" && this.current) {
						this.current.handoffComplete = true;
						await this.captures.update(this.current);
						this.state.capture = this.publicCapture(this.current);
					}
					this.state.phase = result.status;
					this.state.message = result.message;
					this.publish();
				})
				.catch((error) => {
					clearInterval(this.monitor);
					this.monitor = undefined;
					this.fail(error);
				})
				.finally(() => {
					this.monitoring = false;
				});
		}, 750);
	}
	private fail(error: unknown) {
		this.state.phase = "needs-attention";
		this.state.message = pointError(error, "Point could not complete the handoff.").message;
		if (this.current) this.state.capture = this.publicCapture(this.current);
		this.publish();
		this.options.attention();
	}
	async retry() {
		if (this.busy || this.monitor) throw new Error("Finish the current snip first.");
		if (!this.current || !this.captures.items.has(this.current.id))
			throw new Error("This snip is no longer available.");
		this.busy = true;
		this.cancelled = false;
		try {
			if (
				!this.current.target &&
				(!this.current.destination || this.current.destination === "codex-desktop")
			) {
				this.current.target = await this.input(async () =>
					readChatTarget(this.native, await this.native.identify()),
				);
				await this.captures.update(this.current);
			}
			this.state.phase = "opening";
			this.publish();
			await this.deliver();
		} catch (error) {
			this.fail(error);
		} finally {
			this.busy = false;
		}
	}
	async copy() {
		if (!this.current) throw new Error("No snip is available.");
		await clipboard.write([
			new ClipboardItem({
				"image/png": new Blob([new Uint8Array(await this.captures.read(this.current))], {
					type: "image/png",
				}),
			}),
		]);
		this.state.message = "Screenshot copied. Paste it into your Codex draft.";
		this.publish();
	}
	async clear() {
		if (this.busy || this.monitor)
			throw new Error("Finish the current snip before clearing captures.");
		await this.captures.prune(true);
		this.current = undefined;
		this.state.capture = undefined;
		this.state.phase = "idle";
		this.state.message = "Point captures cleared.";
		this.publish();
	}
	async requestPermissions() {
		if (process.platform === "darwin") {
			if (this.state.settings.destination === "codex-desktop")
				systemPreferences.isTrustedAccessibilityClient(true);
			if (systemPreferences.getMediaAccessStatus("screen") !== "granted")
				await shell.openExternal(
					"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
				);
		}
		this.permissions();
		this.publish();
		return this.state;
	}
	suspend() {
		this.cancelCapture();
		clearInterval(this.monitor);
		this.monitor = undefined;
		if (this.current) {
			this.state.phase = "needs-attention";
			this.state.message =
				"Point paused when the screen locked or slept. Check your Codex draft before retrying.";
			this.publish();
		}
	}
	async stop() {
		this.stopping = true;
		this.cancelCapture();
		clearInterval(this.monitor);
		clearInterval(this.cleanup);
		if (this.state.registered) globalShortcut.unregister(this.state.settings.shortcut);
		ipcMain.removeHandler("laplace:point-overlay");
		session.fromPartition("laplace-point-overlay").protocol.unhandle("laplace-desktop");
		await this.server.stop();
	}
	initializationFailed(error: unknown) {
		this.state.available = false;
		this.state.message = error instanceof Error ? error.message : "Point could not initialize.";
		this.publish();
	}
}

function pointError(error: unknown, fallback: string): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string" && error.trim()) return new Error(error);
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
		return new Error(error.message);
	return new Error(fallback);
}
