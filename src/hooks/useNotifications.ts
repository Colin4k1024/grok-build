import { useEffect, useRef } from "react";
import { sendNotification, isPermissionGranted, requestPermission, getCurrentWindow } from "../lib/desktop";
import { onAcpEvent, type AcpEventPayload } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * Desktop notifications (R4-07 #240): the settings store is the single
 * source of truth — this hook subscribes to it (the old one-shot
 * localStorage read could go stale and used a parallel key).
 */
export function useNotifications() {
  const enabledRef = useRef(useSettingsStore.getState().notificationsEnabled);
  const permissionGranted = useRef(false);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tabs = useSessionStore((s) => s.tabs);

  // Mirror the store value into a ref so the event listener always reads
  // the current preference without re-subscribing.
  useEffect(
    () =>
      useSettingsStore.subscribe((s) => {
        enabledRef.current = s.notificationsEnabled;
      }),
    [],
  );

  // Request notification permission once.
  useEffect(() => {
    const init = async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const perm = await requestPermission();
          granted = perm === "granted";
        }
        permissionGranted.current = granted;
      } catch (e) {
        console.warn("Notification permission check failed:", e);
        permissionGranted.current = false;
      }
    };
    init();
  }, []);

  // Listen for ACP events and send notifications when window is not focused
  useEffect(() => {
    const unlisten = onAcpEvent(async (event: AcpEventPayload) => {
      if (!enabledRef.current || !permissionGranted.current) return;

      const sid = event.session_id;
      if (!sid) return;

      // Skip notifications for the active session if the window is focused
      const isFocused = await getCurrentWindow().isFocused().catch(() => true);
      if (isFocused && sid === activeSessionId) return;

      switch (event.type) {
        case "TurnComplete": {
          const tab = tabs.find((t) => t.id === sid);
          const title = tab?.title || "Grok Build";
          try {
            sendNotification({
              title: "Reply completed",
              body: `${title} — agent finished responding`,
            });
          } catch (e) {
            console.error("Notification failed:", e);
          }
          break;
        }
        case "PermissionRequest": {
          const toolName = event.tool_name || "a tool";
          try {
            sendNotification({
              title: "Approval needed",
              body: `${toolName} requires your approval`,
            });
          } catch (e) {
            console.error("Notification failed:", e);
          }
          break;
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [activeSessionId, tabs]);
}
