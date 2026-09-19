import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/sessionStore";

const SAVE_INTERVAL_MS = 10000;
const STORAGE_KEY = "gb-session-backup";

interface BackupData {
  tabs: Array<{ id: string; title: string; cwd: string; model: string; lastActiveAt: number }>;
  savedAt: number;
}

export function useAutoSave() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Snapshot reads inside the interval only — no render-level subscription.
  // A whole-map `messages` selector here re-rendered the App host on every
  // streaming flush (up to 20 Hz) just to save a backup every 10 s.
  useEffect(() => {
    timerRef.current = setInterval(() => {
      try {
        const { tabs, messages } = useSessionStore.getState();
        const backup: BackupData = {
          tabs: tabs.map((t) => ({
            id: t.id,
            title: t.title,
            cwd: t.cwd,
            model: t.model,
            lastActiveAt: t.lastActiveAt,
          })),
          savedAt: Date.now(),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(backup));

        // Save message counts for monitoring (not full messages to avoid quota)
        for (const tab of tabs) {
          const msgs = messages[tab.id] || [];
          if (msgs.length > 0) {
            const key = `gb-msgs-${tab.id}`;
            const lastMessages = msgs.slice(-50).map((m) => ({
              role: m.role,
              content: m.content.slice(0, 500),
              timestamp: m.timestamp,
            }));
            try {
              localStorage.setItem(key, JSON.stringify(lastMessages));
            } catch {
              // Quota exceeded, skip
            }
          }
        }
      } catch (e) {
        console.error("Auto-save failed:", e);
      }
    }, SAVE_INTERVAL_MS);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);
}

export function loadSessionBackup(): BackupData | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;
    return JSON.parse(data) as BackupData;
  } catch {
    return null;
  }
}

export function loadSessionMessages(sessionId: string): Array<{ role: string; content: string; timestamp: number }> {
  try {
    const data = localStorage.getItem(`gb-msgs-${sessionId}`);
    if (!data) return [];
    return JSON.parse(data);
  } catch {
    return [];
  }
}
