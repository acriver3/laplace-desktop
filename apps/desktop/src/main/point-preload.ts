import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("laplacePoint", {
	initialize: () => ipcRenderer.invoke("laplace:point-overlay", { action: "initialize" }),
	select: (rect: unknown) =>
		ipcRenderer.invoke("laplace:point-overlay", { action: "select", rect }),
	cancel: () => ipcRenderer.invoke("laplace:point-overlay", { action: "cancel" }),
});
