import { contextBridge, ipcRenderer } from "electron";

/** Credential-bearing payloads must never reach the logs (review P1). */
const SECRET_CHANNELS = new Set(["login_api_key", "save_api_key"]);

// Bridge tracing is OFF by default. It used to run unconditionally, which put
// a second full IPC round-trip (`invoke("log_frontend")`) plus a
// JSON.stringify in front of EVERY renderer→main call — doubling the latency
// of every command the UI issued. Opt in with GB_BRIDGE_LOG=1 when debugging.
const BRIDGE_LOG =
  process.env.GB_BRIDGE_LOG === "1" || process.env.GB_BRIDGE_LOG === "true";

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
    if (BRIDGE_LOG) {
      // Fire-and-forget: a trace must never add a round-trip to the call it
      // is tracing, and must never reject into the caller's promise chain.
      ipcRenderer
        .send("log_frontend", {
          level: "info",
          message: `[bridge] invoke: ${channel} ${redacted(channel, args)}`,
        });
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, handler: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("electron", api);

if (BRIDGE_LOG) {
  console.log("[preload] bridge exposed to renderer (tracing on)");
}
