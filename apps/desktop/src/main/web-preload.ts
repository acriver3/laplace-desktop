import { contextBridge, ipcRenderer } from "electron";

// Hosted content receives presentation and write-only clipboard bridges, never device operations.
if (process.isMainFrame) {
	contextBridge.exposeInMainWorld("laplaceShell", {
		version: 1,
		credentialsVersion: 1,
		onCredentialsNavigation: (listener: (value: { active: boolean; pending: number }) => void) => {
			let active = true;
			const receive = (
				_event: Electron.IpcRendererEvent,
				value: { active: boolean; pending: number },
			) => listener(value);
			ipcRenderer.on("laplace:credentials-navigation", receive);
			void ipcRenderer
				.invoke("laplace:web-shell", { kind: "credentials-navigation" })
				.then((value) => {
					if (active) listener(value);
				})
				.catch(() => {});
			return () => {
				active = false;
				ipcRenderer.removeListener("laplace:credentials-navigation", receive);
			};
		},
		showUpdates: () => ipcRenderer.invoke("laplace:web-shell", { kind: "show-updates" }),
		onUpdateChange: (listener: (available: boolean) => void) => {
			const receive = (_event: Electron.IpcRendererEvent, available: boolean) =>
				listener(available);
			ipcRenderer.on("laplace:update-available", receive);
			let subscribed = true;
			void ipcRenderer
				.invoke("laplace:web-shell", { kind: "update-status" })
				.then((available) => {
					if (subscribed) listener(available);
				})
				.catch(() => {});
			return () => {
				subscribed = false;
				ipcRenderer.removeListener("laplace:update-available", receive);
			};
		},
		reportLayout: (rect: unknown) =>
			ipcRenderer.invoke("laplace:web-shell", { kind: "layout", rect }),
		showWeb: () => ipcRenderer.invoke("laplace:web-shell", { kind: "web" }),
		onLocalChange: (listener: (active: boolean) => void) => {
			const receive = (_event: Electron.IpcRendererEvent, active: boolean) => listener(active);
			ipcRenderer.on("laplace:local-state", receive);
			let subscribed = true;
			void ipcRenderer
				.invoke("laplace:web-shell", { kind: "status" })
				.then((active) => {
					if (subscribed) listener(active);
				})
				.catch(() => {});
			return () => {
				subscribed = false;
				ipcRenderer.removeListener("laplace:local-state", receive);
			};
		},
	});
	// Chromium combines clipboard read/write permission; expose only validated text writes.
	contextBridge.exposeInMainWorld("laplaceClipboard", {
		writeText: (text: string) => ipcRenderer.invoke("laplace:clipboard-write", text),
	});
	contextBridge.executeInMainWorld({
		func: () => {
			const bridge = (
				window as unknown as {
					laplaceClipboard: { writeText(text: string): Promise<void> };
				}
			).laplaceClipboard;
			if (navigator.clipboard) {
				Object.defineProperty(navigator.clipboard, "writeText", {
					value: (text: string) => bridge.writeText(text),
				});
			}
		},
	});
}
