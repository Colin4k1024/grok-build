import { contextBridge, ipcRenderer } from "electron";

console.log("[preload] loading bridge...");
const api = {
  invoke: (channel: string, ...args: unknown[]) => {
    // Forward to main process log so we can see it even with detached devtools
    ipcRenderer.invoke("log_frontend", { level: "info", message: `[bridge] invoke: ${channel} ${JSON.stringify(args).slice(0, 200)}` });
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, handler: (payload: unknown) => void) => {
    console.log("[preload] registering listener for", channel);
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("electron", api);
console.log("[preload] bridge exposed to renderer");
