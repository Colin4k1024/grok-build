import { useState, useEffect } from "react";
import { useSettingsStore, type ThemeMode, type FontSizeId } from "../../stores/settingsStore";

const FONT_SIZES = [
  { id: "small", label: "小", px: 12 },
  { id: "medium", label: "中", px: 13 },
  { id: "large", label: "大", px: 15 },
  { id: "xlarge", label: "特大", px: 17 },
] as const;

const ZOOM_LEVELS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5] as const;

function applyFontSize(id: FontSizeId) {
  const size = FONT_SIZES.find((s) => s.id === id) ?? FONT_SIZES[1];
  document.documentElement.style.setProperty("font-size", `${size.px}px`);
  document.documentElement.dataset.fontSize = id;
}

function applyZoom(zoom: number) {
  (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(zoom);
}

/** Apply persisted appearance preferences on app boot. Called from main.tsx. */
export function bootstrapAppearance() {
  try {
    const raw = localStorage.getItem("gb-settings");
    if (raw) {
      const parsed = JSON.parse(raw);
      const st = parsed?.state;
      if (st) {
        applyFontSize((st.fontSize as FontSizeId) ?? "medium");
        applyZoom(typeof st.zoom === "number" ? st.zoom : 1.0);
        return;
      }
    }
  } catch {}
  applyFontSize("medium");
  applyZoom(1.0);
}

export function AppearanceSettings() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSizeStore = useSettingsStore((s) => s.setFontSize);
  const zoom = useSettingsStore((s) => s.zoom);
  const setZoomStore = useSettingsStore((s) => s.setZoom);

  const [localFont, setLocalFont] = useState<FontSizeId>(fontSize);
  const [localZoom, setLocalZoom] = useState(zoom);

  useEffect(() => { applyFontSize(localFont); }, [localFont]);
  useEffect(() => { applyZoom(localZoom); }, [localZoom]);

  const handleThemeChange = (t: ThemeMode) => setTheme(t);
  const handleFontSize = (id: FontSizeId) => { setLocalFont(id); setFontSizeStore(id); };
  const handleZoom = (z: number) => { setLocalZoom(z); setZoomStore(z); };

  return (
    <div className="space-y-6 p-4">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">主题</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div className="flex gap-2">
            {(["dark", "light", "auto"] as const).map((t) => (
              <button
                key={t}
                onClick={() => handleThemeChange(t)}
                className={`rounded px-3 py-1.5 text-xs transition-colors ${
                  theme === t
                    ? "bg-gb-accent/15 text-gb-text"
                    : "bg-gb-bg text-gb-muted hover:text-gb-text"
                }`}
              >
                {t === "dark" ? "🌙 深色" : t === "light" ? "☀️ 浅色" : "🖥️ 跟随系统"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gb-muted">
            Auto follows your system theme preference
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">字体大小</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div className="flex gap-2">
            {FONT_SIZES.map((s) => (
              <button
                key={s.id}
                onClick={() => handleFontSize(s.id)}
                className={`rounded px-3 py-1.5 text-xs transition-colors ${
                  fontSize === s.id
                    ? "bg-gb-accent/15 text-gb-text"
                    : "bg-gb-bg text-gb-muted hover:text-gb-text"
                }`}
              >
                {s.label}
                <span className="ml-1 text-[10px] opacity-60">{s.px}px</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gb-muted">
            Base font size for the entire UI
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">窗口缩放</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div className="flex flex-wrap gap-2">
            {ZOOM_LEVELS.map((z) => (
              <button
                key={z}
                onClick={() => handleZoom(z)}
                className={`rounded px-3 py-1.5 text-xs transition-colors ${
                  zoom === z
                    ? "bg-gb-accent/15 text-gb-text"
                    : "bg-gb-bg text-gb-muted hover:text-gb-text"
                }`}
              >
                {Math.round(z * 100)}%
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gb-muted">
            Scale the entire window UI. Useful on high-DPI screens.
          </p>
        </div>
      </section>
    </div>
  );
}
