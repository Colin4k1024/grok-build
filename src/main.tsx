import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { bootstrapAppearance } from "./components/settings/AppearanceSettings";
import "./styles.css";

// Apply persisted font size and window zoom before first paint.
bootstrapAppearance();

// Self-test: verify the desktop bridge is available.
if (typeof window !== "undefined") {
  const win = window as { electron?: { invoke: (c: string, ...a: unknown[]) => Promise<unknown>; platform: string } };
  if (win.electron) {
    console.log("[main.tsx] ✅ Electron bridge detected, platform:", win.electron.platform);
    // Quick smoke test: call a no-op IPC
    win.electron.invoke("log_frontend", { level: "info", message: "[main.tsx] Bridge self-test passed" })
      .then(() => console.log("[main.tsx] ✅ bridge.invoke() works"))
      .catch((e: Error) => console.error("[main.tsx] ❌ bridge.invoke() FAILED:", e.message));
  } else {
    console.error("[main.tsx] ❌ window.electron is UNDEFINED — preload did not load!");
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
