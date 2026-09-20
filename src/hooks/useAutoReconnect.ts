import { useEffect, useRef, useCallback } from "react";
import { onAcpEvent, createSession } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const MAX_RETRIES = 8;

function backoffDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

export function useAutoReconnect() {
  const retryCount = useRef<Record<string, number>>({});
  const timers = useRef<Record<string, number>>({});
  const tabs = useSessionStore((s) => s.tabs);
  const addTab = useSessionStore((s) => s.addTab);
  const removeTab = useSessionStore((s) => s.removeTab);
  const setConnectionStatus = useSessionStore((s) => s.setConnectionStatus);

  const clearTimer = useCallback((sessionId: string) => {
    if (timers.current[sessionId]) { clearTimeout(timers.current[sessionId]); delete timers.current[sessionId]; }
  }, []);

  const attemptReconnect = useCallback(async (sessionId: string, cwd: string, title: string) => {
    const retries = retryCount.current[sessionId] || 0;
    if (retries >= MAX_RETRIES) {
      console.error(`[acp-reconnect] Max retries exhausted for ${sessionId}`);
      setConnectionStatus(sessionId, "error", `Reconnection failed after ${MAX_RETRIES} attempts.`);
      delete retryCount.current[sessionId];
      return;
    }
    const delay = backoffDelay(retries);
    retryCount.current[sessionId] = retries + 1;
    setConnectionStatus(sessionId, "reconnecting", `Reconnecting (attempt ${retries + 1}/${MAX_RETRIES})...`);
    console.log(`[acp-reconnect] Attempt ${retries + 1}/${MAX_RETRIES} for ${sessionId} after ${delay}ms`);

    timers.current[sessionId] = window.setTimeout(() => {
      delete timers.current[sessionId];
      createSession(cwd).then((info) => {
        removeTab(sessionId);
        addTab({ id: info.id, title, cwd, model: info.models[0]?.id || "", reasoningEffort: "medium", createdAt: Date.now(), lastActiveAt: Date.now() });
        retryCount.current[sessionId] = 0;
        setConnectionStatus(sessionId, "connected", null);
      }).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[acp-reconnect] Attempt ${retries + 1} failed:`, msg);
        if (msg.includes("ENOENT") || msg.includes("command not found") || msg.includes("not found")) {
          setConnectionStatus(sessionId, "error", "Agent binary (xai-grok-pager) is unavailable.");
          delete retryCount.current[sessionId];
          return;
        }
        attemptReconnect(sessionId, cwd, title);
      });
    }, delay);
  }, [addTab, removeTab, setConnectionStatus]);

  useEffect(() => () => { Object.keys(timers.current).forEach((sid) => clearTimer(sid)); }, [clearTimer]);

  useEffect(() => {
    const unlisten = onAcpEvent((event) => {
      if (event.type === "Error" && event.message?.includes("Agent process exited")) {
        const sid = event.session_id; if (!sid) return;
        if (useSessionStore.getState().connectionStatus[sid] === "reconnecting") return;
        const tab = tabs.find((t) => t.id === sid);
        if (tab) { clearTimer(sid); retryCount.current[sid] = 0; attemptReconnect(sid, tab.cwd, tab.title); }
      }
      if (event.type === "Close") {
        const sid = event.session_id; if (!sid) return;
        clearTimer(sid); delete retryCount.current[sid];
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [tabs, attemptReconnect, clearTimer]);
}
