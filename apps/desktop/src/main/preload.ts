import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { DesktopBridge } from "../shared/shell-contracts";

const bridge: DesktopBridge = {
	pathForFile: (file) => webUtils.getPathForFile(file),
	invoke: (method, input) =>
		ipcRenderer.invoke("laplace:request", { method, ...(input === undefined ? {} : { input }) }),
	onEvent(listener) {
		const wrapped = (_event: Electron.IpcRendererEvent, value: { event: string; data?: unknown }) =>
			listener(value);
		ipcRenderer.on("laplace:event", wrapped);
		return () => ipcRenderer.removeListener("laplace:event", wrapped);
	},
};
contextBridge.exposeInMainWorld("laplaceDesktop", bridge);
