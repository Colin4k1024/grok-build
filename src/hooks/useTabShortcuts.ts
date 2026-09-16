import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";

interface ShortcutHandlers {
  onNewSession: () => void;
  onCloseActiveTab: () => void;
}

export function useTabShortcuts({ onNewSession, onCloseActiveTab }: ShortcutHandlers) {
  const tabs = useSessionStore((s) => s.tabs);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const mod = isMac ? "Meta" : "Control";

    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl + N — new session
      if (e.key === "n" && e.getModifierState(mod)) {
        e.preventDefault();
        onNewSession();
        return;
      }

      // Cmd/Ctrl + W — close active tab
      if (e.key === "w" && e.getModifierState(mod)) {
        e.preventDefault();
        onCloseActiveTab();
        return;
      }

      // Cmd/Ctrl + 1-9 — switch to tab by index
      const num = parseInt(e.key, 10);
      if (!isNaN(num) && num >= 1 && num <= 9 && e.getModifierState(mod)) {
        e.preventDefault();
        const tab = tabs[num - 1];
        if (tab) setActiveSession(tab.id);
        return;
      }

      // Cmd/Ctrl + Tab / Shift+Tab — cycle tabs
      if (e.key === "Tab" && e.getModifierState(mod)) {
        e.preventDefault();
        if (tabs.length === 0) return;
        const currentIdx = tabs.findIndex((t) => t.id === activeSessionId);
        const nextIdx = e.shiftKey
          ? (currentIdx - 1 + tabs.length) % tabs.length
          : (currentIdx + 1) % tabs.length;
        setActiveSession(tabs[nextIdx].id);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs, activeSessionId, setActiveSession, onNewSession, onCloseActiveTab]);
}
