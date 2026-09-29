import { useSettingsStore } from "../stores/settingsStore";

/**
 * Appearance application (R4-07 #240): the ONLY place font size and zoom
 * reach the DOM. Boot applies persisted values; a store subscription keeps
 * them live for every writer path (registry fields, presets, imports).
 */

export const FONT_SIZES = [
  { id: "small", label: "小", px: 12 },
  { id: "medium", label: "中", px: 13 },
  { id: "large", label: "大", px: 15 },
  { id: "xlarge", label: "特大", px: 17 },
] as const;

export const ZOOM_LEVELS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5] as const;

export function applyFontSize(id: string) {
  const size = FONT_SIZES.find((s) => s.id === id) ?? FONT_SIZES[1];
  document.documentElement.style.setProperty("font-size", `${size.px}px`);
  document.documentElement.dataset.fontSize = id;
}

export function applyZoom(zoom: number) {
  (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(zoom);
}

/** Apply persisted appearance preferences on app boot. Called from main.tsx. */
export function bootstrapAppearance() {
  try {
    const raw = localStorage.getItem("gb-settings");
    if (raw) {
      const st = JSON.parse(raw)?.state;
      if (st) {
        applyFontSize(typeof st.fontSize === "string" ? st.fontSize : "medium");
        applyZoom(typeof st.zoom === "number" ? st.zoom : 1.0);
        return;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  applyFontSize("medium");
  applyZoom(1.0);
}

// Live application: any store change (settings UI, presets, imports,
// multi-window sync) is reflected immediately.
if (typeof window !== "undefined") {
  useSettingsStore.subscribe((s) => {
    applyFontSize(s.fontSize);
    applyZoom(s.zoom);
  });
}
