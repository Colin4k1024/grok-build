import { useState, useEffect } from "react";
import { getThemeMode, setThemeMode, type ThemeMode } from "../../hooks/useTheme";

const FONT_SIZE_KEY = "gb-font-size";
const ZOOM_KEY = "gb-zoom";

const FONT_SIZES = [
  { id: "small", label: "Small", px: 12 },
  { id: "medium", label: "Medium", px: 13 },
  { id: "large", label: "Large", px: 15 },
  { id: "xlarge", label: "Extra Large", px: 17 },
] as const;
type FontSizeId = (typeof FONT_SIZES)[number]["id"];

const ZOOM_LEVELS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5] as const;

function applyFontSize(id: FontSizeId) {
  const size = FONT_SIZES.find((s) => s.id === id) ?? FONT_SIZES[1];
  document.documentElement.style.setProperty("font-size", `${size.px}px`);
  document.documentElement.dataset.fontSize = id;
}

function applyZoom(zoom: number) {
  // Tauri webview respects CSS zoom on the root element.
  (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(zoom);
}

export function getSavedFontSize(): FontSizeId {
  return (localStorage.getItem(FONT_SIZE_KEY) as FontSizeId) || "medium";
}

export function getSavedZoom(): number {
  const raw = localStorage.getItem(ZOOM_KEY);
  const parsed = raw ? parseFloat(raw) : 1.0;
  return ZOOM_LEVELS.includes(parsed as (typeof ZOOM_LEVELS)[number]) ? parsed : 1.0;
}

/** Apply persisted appearance preferences on app boot. Called from main.tsx. */
export function bootstrapAppearance() {
  applyFontSize(getSavedFontSize());
  applyZoom(getSavedZoom());
}

export function AppearanceSettings() {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getThemeMode());
  const [fontSize, setFontSize] = useState<FontSizeId>(getSavedFontSize());
  const [zoom, setZoom] = useState<number>(getSavedZoom());

  useEffect(() => {
    // Ensure DOM reflects the current settings on mount (in case user lands
    // directly on Settings before bootstrapAppearance runs).
    applyFontSize(fontSize);
    applyZoom(zoom);
  }, [fontSize, zoom]);

  const handleThemeChange = (t: ThemeMode) => {
    setThemeModeState(t);
    setThemeMode(t);
  };

  const handleFontSize = (id: FontSizeId) => {
    setFontSize(id);
    localStorage.setItem(FONT_SIZE_KEY, id);
  };

  const handleZoom = (z: number) => {
    setZoom(z);
    localStorage.setItem(ZOOM_KEY, String(z));
  };

  return (
    <div className="space-y-6 p-4">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Theme</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div className="flex gap-2">
            {(["dark", "light", "auto"] as const).map((t) => (
              <button
                key={t}
                onClick={() => handleThemeChange(t)}
                className={`rounded px-3 py-1.5 text-xs transition-colors ${
                  themeMode === t
                    ? "bg-gb-accent/15 text-gb-text"
                    : "bg-gb-bg text-gb-muted hover:text-gb-text"
                }`}
              >
                {t === "dark" ? "🌙 Dark" : t === "light" ? "☀️ Light" : "🖥️ Auto"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gb-muted">
            Auto follows your system theme preference
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Font size</h3>
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
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Window zoom</h3>
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
