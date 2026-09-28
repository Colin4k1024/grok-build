/**
 * Renderer client for the unified settings file IPC (R4-05 #238).
 * Returns null outside Electron (plain browser dev, jsdom tests) so every
 * consumer can feature-test cleanly.
 */

export interface SettingsFileDoc {
  version: 1;
  values: Record<string, unknown>;
}

export interface GbSettingsBridge {
  getAll: () => Promise<SettingsFileDoc>;
  set: (key: string, value: unknown) => Promise<SettingsFileDoc>;
  delete: (key: string) => Promise<SettingsFileDoc>;
  reset: () => Promise<SettingsFileDoc>;
  onChanged: (handler: (doc: SettingsFileDoc) => void) => () => void;
}

declare global {
  interface Window {
    gbSettings?: GbSettingsBridge;
  }
}

export function getSettingsBridge(): GbSettingsBridge | null {
  if (typeof window === "undefined") return null;
  return window.gbSettings ?? null;
}
