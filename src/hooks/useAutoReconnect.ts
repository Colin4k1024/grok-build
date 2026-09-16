import { useEffect, useRef, useCallback } from "react";
import { onAcpEvent, createSession } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export function useAutoReconnect() {
  const retryCount = useRef<Record<string, number>>({});
  const tabs = useSessionStore((s) => s.tabs);
  const addTab = useSessionStore((s) => s.addTab);
  const removeTab = useSessionStore((s) => s.removeTab);
  const renameTab = useSessionStore((s) => s.renameTab);

  const attemptReconnect = useCallback(async (sessionId: string, cwd: string, title: string) => {
    const retries = retryCount.current[sessionId] || 0;
    if (retries >= MAX_RETRIES) {
      console.error(`Max retries (${MAX_RETRIES}) reached for session ${sessionId}`);
      return;
    }

    retryCount.current[sessionId] = retries + 1;
    console.log(`Reconnect attempt ${retries + 1}/${MAX_RETRIES} for session ${sessionId}`);

    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));

    try {
      const info = await createSession(cwd);
      // Replace the old session with the new one
      removeTab(sessionId);
      addTab({
        id: info.id,
        title,
        cwd,
        model: info.models[0]?.id || "",
        reasoningEffort: "medium",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      retryCount.current[sessionId] = 0;
      console.log(`Reconnected session ${sessionId} → ${info.id}`);
    } catch (e) {
      console.error("Reconnect failed:", e);
      // Will retry again on next error event
    }
  }, [addTab, removeTab, renameTab]);

  useEffect(() => {
    const unlisten = onAcpEvent((event) => {
      if (event.type === "Error" && event.message?.includes("Agent process exited")) {
        const sid = event.session_id;
        if (!sid) return;
        const tab = tabs.find((t) => t.id === sid);
        if (tab) {
          attemptReconnect(sid, tab.cwd, tab.title);
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [tabs, attemptReconnect]);
}
