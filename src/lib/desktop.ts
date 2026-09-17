/**
 * Electron-side replacements for Tauri plugins. These talk to the Electron
 * main process via window.electron.invoke, which exposes the corresponding
 * Node APIs (clipboard, shell, notifications, etc.).
 */

import { invoke } from "./tauri";

// --- clipboard (was @tauri-apps/plugin-clipboard-manager) ---
export async function writeText(text: string): Promise<void> {
  await invoke("clipboard_write_text", { text });
}

export async function readText(): Promise<string> {
  return invoke<string>("clipboard_read_text");
}

// --- window (was @tauri-apps/api/window) ---
export interface WindowHandle {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
  setFocus(): Promise<void>;
  isFocused(): Promise<boolean>;
}

export function getCurrentWindow(): WindowHandle {
  return {
    minimize: () => invoke("window_minimize"),
    toggleMaximize: () => invoke("window_toggle_maximize"),
    close: () => invoke("window_close"),
    startDragging: () => invoke("window_start_dragging"),
    setFocus: () => invoke("window_set_focus"),
    isFocused: () => invoke<boolean>("window_is_focused"),
  };
}

// --- notifications (was @tauri-apps/plugin-notification) ---
export async function sendNotification(opts: { title: string; body?: string }): Promise<void> {
  await invoke("notification_send", opts);
}

export async function isPermissionGranted(): Promise<boolean> {
  return invoke<boolean>("notification_is_permitted");
}

export async function requestPermission(): Promise<string> {
  return invoke<string>("notification_request_permission");
}

// --- updater (was @tauri-apps/plugin-updater) ---
export interface UpdateInfo {
  version: string;
  body?: string | null;
  date?: string | null;
}

export interface UpdateHandle {
  version: string;
  body: string | null;
  date: string | null;
  downloadAndInstall: (onProgress?: (ev: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
}

export async function check(): Promise<UpdateHandle | null> {
  return invoke<UpdateHandle | null>("updater_check");
}

// --- process (was @tauri-apps/plugin-process) ---
export async function relaunch(): Promise<void> {
  await invoke("app_relaunch");
}
