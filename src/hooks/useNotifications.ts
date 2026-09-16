import { useEffect, useRef } from "react";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onAcpEvent, type AcpEventPayload } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";

const NOTIF_SETTING_KEY = "gb-notifications-enabled";

export function useNotifications() {
  const enabled = useRef(false);
  const permissionGranted = useRef(false);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tabs = useSessionStore((s) => s.tabs);

  // Load notification preference
  useEffect(() => {
    const stored = localStorage.getItem(NOTIF_SETTING_KEY);
    enabled.current = stored === null ? true : stored === "true";

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
      if (!enabled.current || !permissionGranted.current) return;

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

  return {
    isEnabled: () => enabled.current,
    setEnabled: (val: boolean) => {
      enabled.current = val;
      localStorage.setItem(NOTIF_SETTING_KEY, String(val));
    },
  };
}

export function getNotificationEnabled(): boolean {
  return localStorage.getItem(NOTIF_SETTING_KEY) !== "false";
}

export function setNotificationEnabled(val: boolean) {
  localStorage.setItem(NOTIF_SETTING_KEY, String(val));
}
