import { useState, useEffect, useCallback } from "react";

type ThemeMode = "dark" | "light" | "auto";
const THEME_KEY = "gb-theme-mode";

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
  const [mode, setMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem(THEME_KEY) as ThemeMode) || "dark";
  });

  useEffect(() => {
    applyTheme(mode);
    localStorage.setItem(THEME_KEY, mode);
  }, [mode]);

  // Listen for system theme changes when in auto mode
  useEffect(() => {
    if (mode !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => applyTheme("auto");
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [mode]);

  const changeMode = useCallback((newMode: ThemeMode) => {
    setMode(newMode);
  }, []);

  return { mode, changeMode };
}

export function getThemeMode(): ThemeMode {
  return (localStorage.getItem(THEME_KEY) as ThemeMode) || "dark";
}

export function setThemeMode(mode: ThemeMode) {
  localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
}
