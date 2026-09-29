import { useEffect, useCallback, useMemo } from "react";
import { useSettingsStore, type ThemeMode } from "../stores/settingsStore";
import { useSessionStore } from "../stores/sessionStore";
import { getSetting } from "../config/registry";
import { resolveSetting } from "../config/resolve";

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(mode: ThemeMode) {
  const effective = mode === "auto" ? getSystemTheme() : mode;
  const root = document.documentElement;
  if (effective === "light") {
    root.classList.add("light");
    root.classList.remove("dark");
  } else {
    root.classList.add("dark");
    root.classList.remove("light");
  }
}

export function useTheme() {
  const globalTheme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  // R4-07 (#240): project overrides are real — the active project's theme
  // override wins over the global value while that project is active.
  const activeCwd = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeSessionId)?.cwd,
  );
  const projectOverride = useSettingsStore((s) =>
    activeCwd ? s.projectOverrides[activeCwd]?.["appearance.theme"] : undefined,
  );
  const theme = useMemo(() => {
    const def = getSetting("appearance.theme");
    if (!def) return globalTheme;
    const r = resolveSetting(def as never, { global: globalTheme, project: projectOverride });
    return r.value as ThemeMode;
  }, [globalTheme, projectOverride]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Listen for system theme changes when in auto mode
  useEffect(() => {
    if (theme !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => applyTheme("auto");
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [theme]);

  const changeMode = useCallback((newMode: ThemeMode) => {
    setTheme(newMode);
  }, [setTheme]);

  return { mode: theme, changeMode };
}

export { type ThemeMode };