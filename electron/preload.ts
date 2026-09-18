import { contextBridge, ipcRenderer } from "electron";

console.log("[preload] loading bridge...");
/** Credential-bearing payloads must never reach the logs (review P1). */
const SECRET_CHANNELS = new Set(["login_api_key", "save_api_key"]);
function redacted(channel: string, args: unknown[]): string {
  if (SECRET_CHANNELS.has(channel)) return "[redacted]";
  try {
    return JSON.stringify(args).slice(0, 200);
  } catch {
    return "[unserializable]";
  }
}

const api = {
  invoke: (channel: string, ...args: unknown[]) => {
    // Forward to main process log so we can see it even with detached devtools
    ipcRenderer.invoke("log_frontend", { level: "info", message: `[bridge] invoke: ${channel} ${redacted(channel, args)}` });
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
