import { useSettingsStore } from "../stores/settingsStore";
import { useSessionStore } from "../stores/sessionStore";
import { resolveFromStore } from "../config/storeBridge";

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

/** Apply persisted appearance preferences on app boot. Called from main.tsx.
 *  The stores rehydrate synchronously at module init, so resolve the
 *  effective (project-aware) values the same way the live subscription does
 *  — never read raw localStorage here, which would clobber a project zoom
 *  override with the global value at boot (R4-08 #241). */
export function bootstrapAppearance() {
  try {
    const ss = useSessionStore.getState();
    const cwd = ss.tabs.find((t) => t.id === ss.activeSessionId)?.cwd;
    applyFontSize(resolveFromStore("appearance.fontSize", cwd).value as string);
    applyZoom(resolveFromStore("appearance.zoom", cwd).value as number);
  } catch {
    applyFontSize("medium");
    applyZoom(1.0);
  }
}

// Live application: any store change (settings UI, presets, imports,
// multi-window sync) is reflected immediately. Project-aware (R4-08 #241):
// the active project's zoom override wins over the global value, mirroring
// useTheme's theme resolution — so a project-scoped appearance.zoom edit
// actually reaches the DOM. (fontSize is global-only today; resolving with
// projectId is still safe — resolveSetting skips the project layer for
// settings whose scopes don't include "project".)
if (typeof window !== "undefined") {
  let prevFont = "";
  let prevZoom = -1;
  let prevCwd: string | undefined;
  const apply = () => {
    const ss = useSessionStore.getState();
    const cwd = ss.tabs.find((t) => t.id === ss.activeSessionId)?.cwd;
    const font = resolveFromStore("appearance.fontSize", cwd).value as string;
    const zoom = resolveFromStore("appearance.zoom", cwd).value as number;
    if (font === prevFont && zoom === prevZoom && cwd === prevCwd) return;
    prevFont = font;
    prevZoom = zoom;
    prevCwd = cwd;
    applyFontSize(font);
    applyZoom(zoom);
  };
  apply();
  useSettingsStore.subscribe(apply);
  useSessionStore.subscribe(apply);
}
