import { useEffect, useCallback } from "react";
import { useSettingsStore, type ThemeMode } from "../stores/settingsStore";

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
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

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