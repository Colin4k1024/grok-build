import { useState, useEffect, useCallback } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { sendNotification } from "@tauri-apps/plugin-notification";

interface UpdateState {
  checking: boolean;
  updateAvailable: boolean;
  version: string | null;
  downloading: boolean;
  installed: boolean;
  error: string | null;
  /** 0-100 while downloading, null otherwise. */
  progress: number | null;
  /** Release notes body when the manifest provides it. */
  releaseNotes: string | null;
  /** Release date from the manifest. */
  releaseDate: string | null;
}

export function useUpdater() {
  const [state, setState] = useState<UpdateState>({
    checking: false,
    updateAvailable: false,
    version: null,
    downloading: false,
    installed: false,
    error: null,
    progress: null,
    releaseNotes: null,
    releaseDate: null,
  });

  const checkForUpdates = useCallback(async (silent = false) => {
    setState((s) => ({ ...s, checking: true, error: null }));
    try {
      const update = await check();
      if (update) {
        setState((s) => ({
          ...s,
          checking: false,
          updateAvailable: true,
          version: update.version,
          releaseNotes: update.body ?? null,
          releaseDate: update.date ?? null,
        }));
        if (!silent) {
          try {
            sendNotification({
              title: "Update Available",
              body: `Version ${update.version} is ready to install`,
            });
          } catch (e) {
            console.error("Notification failed:", e);
          }
        }
      } else {
        setState((s) => ({
          ...s,
          checking: false,
          updateAvailable: false,
        }));
      }
    } catch (e) {
      // Updater not configured (no endpoint/key) — silent fail
      setState((s) => ({ ...s, checking: false, error: String(e) }));
      if (!silent) {
        console.log("Update check failed (endpoint may not be configured):", e);
      }
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    setState((s) => ({ ...s, downloading: true, error: null, progress: 0 }));
    try {
      const update = await check();
      if (!update) {
        setState((s) => ({ ...s, downloading: false, progress: null }));
        return;
      }

      let contentLength = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          contentLength = event.data.contentLength;
        } else if (event.event === "Progress" && contentLength > 0) {
          downloaded += event.data.chunkLength;
          const percent = Math.round((downloaded / contentLength) * 100);
          setState((s) => ({ ...s, progress: percent }));
        }
      });

      setState((s) => ({ ...s, downloading: false, installed: true, progress: 100 }));
      await relaunch();
    } catch (e) {
      setState((s) => ({ ...s, downloading: false, error: String(e), progress: null }));
    }
  }, []);

  // Silent check on startup
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdates(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, [checkForUpdates]);

  return {
    ...state,
    checkForUpdates,
    downloadAndInstall,
  };
}
