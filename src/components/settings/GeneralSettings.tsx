import { useState, useEffect } from "react";
import { isAutostartEnabled, enableAutostart, disableAutostart } from "../../lib/tauri";
import { getNotificationEnabled, setNotificationEnabled } from "../../hooks/useNotifications";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUpdater } from "../../hooks/useUpdater";

export function GeneralSettings() {
  const [autostart, setAutostart] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notifEnabled, setNotifEnabled] = useState(getNotificationEnabled());
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
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
        <h3 className="mb-3 text-sm font-semibold text-gb-text">更新</h3>
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
              <p className="mt-0.5 text-[11px] text-gb-muted">点击下载并安装，应用将自动重启。</p>
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
                className="mt-2 rounded bg-gb-accent px-3 py-1.5 text-xs text-gb-bg disabled:opacity-50"
              >
                {updater.downloading ? "下载中…" : "下载并安装"}
              </button>
            </div>
          ) : updater.installed ? (
            <p className="text-xs text-gb-green">更新已安装，正在重启…</p>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-gb-text">
                  {updater.checking ? "检查更新中…" : "已是最新"}
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
            <p className="mt-1 text-[10px] text-gb-muted">检查更新需要先配置更新服务器</p>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">外观</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <p className="mb-2 text-xs font-medium text-gb-text">主题</p>
          <div className="flex gap-2">
            {(["dark", "light", "auto"] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTheme(t);
                }}
                className={`rounded px-3 py-1.5 text-xs ${
                  theme === t ? "bg-gb-accent/15 text-gb-text" : "bg-gb-bg text-gb-muted"
                }`}
              >
                {t === "dark" ? "🌙 深色" : t === "light" ? "☀️ 浅色" : "🖥️ 跟随系统"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gb-muted">「跟随系统」会按系统外观自动切换</p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">启动</h3>
        <label className="flex items-center justify-between rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div>
            <p className="text-xs font-medium text-gb-text">开机启动</p>
            <p className="mt-0.5 text-[11px] text-gb-muted">登录系统时自动启动 Grok Build</p>
          </div>
          <button
            onClick={toggleAutostart}
            disabled={loading}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              autostart ? "bg-gb-accent" : "bg-gb-border"
            } disabled:opacity-50`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-gb-bg transition-transform ${
                autostart ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">通知</h3>
        <label className="flex items-center justify-between rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div>
            <p className="text-xs font-medium text-gb-text">桌面通知</p>
            <p className="mt-0.5 text-[11px] text-gb-muted">当 Agent 回复或需要审批时通知我（窗口在后台时）</p>
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
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-gb-bg transition-transform ${
                notifEnabled ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">快捷键</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gb-text">切换窗口</p>
            <kbd className="rounded border border-gb-border px-1.5 py-0.5 text-[10px] text-gb-muted">⌘⇧A</kbd>
          </div>
          <p className="mt-0.5 text-[11px] text-gb-muted">在任意位置显示或隐藏应用窗口</p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">托盘</h3>
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
