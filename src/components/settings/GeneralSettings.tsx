import { useState, useEffect } from "react";
import { isAutostartEnabled, enableAutostart, disableAutostart } from "../../lib/tauri";
import { getNotificationEnabled, setNotificationEnabled } from "../../hooks/useNotifications";
import { getThemeMode, setThemeMode } from "../../hooks/useTheme";
import { useUpdater } from "../../hooks/useUpdater";

export function GeneralSettings() {
  const [autostart, setAutostart] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notifEnabled, setNotifEnabled] = useState(getNotificationEnabled());
  const [themeMode, setThemeModeState] = useState(getThemeMode());
  const updater = useUpdater();

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
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Updates</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          {updater.updateAvailable ? (
            <div>
              <p className="text-xs font-medium text-gb-text">Update available — v{updater.version}</p>
              {updater.releaseDate && (
                <p className="mt-0.5 text-[10px] text-gb-muted">
                  Released {new Date(updater.releaseDate).toLocaleDateString()}
                </p>
              )}
              {updater.releaseNotes && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-gb-accent hover:underline">
                    Release notes
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap rounded bg-gb-bg p-2 text-[10px] text-gb-text-secondary">
                    {updater.releaseNotes}
                  </p>
                </details>
              )}
              <p className="mt-0.5 text-[11px] text-gb-muted">Click to download and install. The app will restart.</p>
              {updater.downloading && updater.progress !== null && (
                <div className="mt-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-gb-bg">
                    <div
                      className="h-full bg-gb-accent transition-all"
                      style={{ width: `${updater.progress}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-[10px] tabular-nums text-gb-muted">
                    {updater.progress}%
                  </p>
                </div>
              )}
              <button
                onClick={() => updater.downloadAndInstall()}
                disabled={updater.downloading}
                className="mt-2 rounded bg-gb-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                {updater.downloading ? "Downloading..." : "Download & Install"}
              </button>
            </div>
          ) : updater.installed ? (
            <p className="text-xs text-gb-green">Update installed. Restarting...</p>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-gb-text">
                  {updater.checking ? "Checking for updates..." : "Up to date"}
                </p>
                <p className="mt-0.5 text-[11px] text-gb-muted">Version 0.1.0</p>
              </div>
              <button
                onClick={() => updater.checkForUpdates(false)}
                disabled={updater.checking}
                className="rounded border border-gb-border px-3 py-1.5 text-xs text-gb-muted hover:text-gb-text disabled:opacity-50"
              >
                Check Now
              </button>
            </div>
          )}
          {updater.error && (
            <p className="mt-1 text-[10px] text-gb-muted">Update check requires a configured endpoint</p>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Appearance</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <p className="mb-2 text-xs font-medium text-gb-text">Theme</p>
          <div className="flex gap-2">
            {(["dark", "light", "auto"] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setThemeModeState(t);
                  setThemeMode(t);
                }}
                className={`rounded px-3 py-1.5 text-xs ${
                  themeMode === t ? "bg-gb-accent/15 text-gb-text" : "bg-gb-bg text-gb-muted"
                }`}
              >
                {t === "dark" ? "🌙 Dark" : t === "light" ? "☀️ Light" : "🖥️ Auto"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gb-muted">Auto follows your system theme preference</p>
        </div>
      </section>

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
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Notifications</h3>
        <label className="flex items-center justify-between rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div>
            <p className="text-xs font-medium text-gb-text">Desktop notifications</p>
            <p className="mt-0.5 text-[11px] text-gb-muted">Notify when agent replies or needs approval (when window is in background)</p>
          </div>
          <button
            onClick={() => {
              const val = !notifEnabled;
              setNotifEnabled(val);
              setNotificationEnabled(val);
            }}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              notifEnabled ? "bg-gb-accent" : "bg-gb-border"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                notifEnabled ? "translate-x-4" : "translate-x-0.5"
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
