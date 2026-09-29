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

export function applyFontSize(id: string) {
  const size = FONT_SIZES.find((s) => s.id === id) ?? FONT_SIZES[1];
  document.documentElement.style.setProperty("font-size", `${size.px}px`);
  document.documentElement.dataset.fontSize = size.id; // validated, never raw
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
        // Apply the registry's range rule even on the boot read path.
        const z = typeof st.zoom === "number" && st.zoom >= 0.5 && st.zoom <= 2.5 ? st.zoom : 1.0;
        applyZoom(z);
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
// multi-window sync) is reflected immediately. Narrow selector — only
// fontSize/zoom changes repaint.
if (typeof window !== "undefined") {
  let prevFont = useSettingsStore.getState().fontSize;
  let prevZoom = useSettingsStore.getState().zoom;
  useSettingsStore.subscribe((s) => {
    if (s.fontSize === prevFont && s.zoom === prevZoom) return;
    prevFont = s.fontSize;
    prevZoom = s.zoom;
    applyFontSize(s.fontSize);
    applyZoom(s.zoom);
  });
}
