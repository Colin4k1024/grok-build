import { useState, useEffect } from "react";
import { isAutostartEnabled, enableAutostart, disableAutostart } from "../../lib/tauri";

export function GeneralSettings() {
  const [autostart, setAutostart] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    isAutostartEnabled()
      .then(setAutostart)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function toggleAutostart() {
    setLoading(true);
    try {
      if (autostart) {
        await disableAutostart();
        setAutostart(false);
      } else {
        await enableAutostart();
        setAutostart(true);
      }
    } catch (e) {
      console.error("Failed to toggle autostart:", e);
    }
    setLoading(false);
  }

  return (
    <div className="space-y-6 p-4">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Startup</h3>
        <label className="flex items-center justify-between rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div>
            <p className="text-xs font-medium text-gb-text">Launch at startup</p>
            <p className="mt-0.5 text-[11px] text-gb-muted">Automatically start Grok Build when you log in</p>
          </div>
          <button
            onClick={toggleAutostart}
            disabled={loading}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              autostart ? "bg-gb-accent" : "bg-gb-border"
            } disabled:opacity-50`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                autostart ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Shortcuts</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gb-text">Toggle window</p>
            <kbd className="rounded border border-gb-border px-1.5 py-0.5 text-[10px] text-gb-muted">⌘⇧A</kbd>
          </div>
          <p className="mt-0.5 text-[11px] text-gb-muted">Show or hide the app window from anywhere</p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Tray</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <p className="text-xs text-gb-muted">
            Closing the window minimizes Grok Build to the system tray.
            Click the tray icon or use the shortcut to restore it.
          </p>
        </div>
      </section>
    </div>
  );
}
