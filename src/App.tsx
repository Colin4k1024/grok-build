import { useState, useEffect, useCallback } from "react";
import { useAcpEventListener } from "./hooks/useAcpSession";
import { useSessionStore } from "./stores/sessionStore";
import { MessageList } from "./components/chat/MessageList";
import { PromptInput } from "./components/chat/PromptInput";
import { createSession, sendMessage, cancelSession, getAuthStatus, getConfig, type AuthStatus, type ConfigSnapshot } from "./lib/tauri";

export default function App() {
  useAcpEventListener();

  const { messages, activeSessionId, isStreaming, setActiveSession, setStreaming, addUserMessage, clearMessages } = useSessionStore();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    getAuthStatus().then(setAuth).catch((e) => setError(String(e)));
    getConfig().then(setConfig).catch((e) => setError(String(e)));
  }, []);

  const handleNewSession = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const info = await createSession(".");
      setActiveSession(info.id);
      clearMessages(info.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }, [setActiveSession, clearMessages]);

  const handleSend = useCallback(async (message: string) => {
    if (!activeSessionId) return;
    addUserMessage(activeSessionId, message);
    setStreaming(true);
    try {
      await sendMessage(activeSessionId, message);
    } catch (e) {
      setError(String(e));
      setStreaming(false);
    }
  }, [activeSessionId, addUserMessage, setStreaming]);

  const handleCancel = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      await cancelSession(activeSessionId);
    } catch (e) {
      setError(String(e));
    }
    setStreaming(false);
  }, [activeSessionId, setStreaming]);

  const currentMessages = activeSessionId ? (messages[activeSessionId] || []) : [];

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      {/* Title bar */}
      <header className="flex h-12 items-center justify-between border-b border-gb-border bg-gb-surface px-4">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">Grok Build</h1>
          {config && (
            <span className="text-xs text-gb-muted">{config.default_model}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {auth?.authenticated ? (
            <span className="text-xs text-gb-green">● Connected</span>
          ) : (
            <span className="text-xs text-gb-yellow">● Not logged in</span>
          )}
          <button
            className="rounded bg-gb-accent px-3 py-1 text-xs text-white hover:opacity-80 disabled:opacity-40"
            onClick={handleNewSession}
            disabled={creating}
          >
            {creating ? "Starting..." : "+ New Session"}
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Chat area */}
        <div className="flex flex-1 flex-col">
          {error && (
            <div className="border-b border-gb-red/30 bg-gb-red/10 px-4 py-2 text-xs text-gb-red">
              {error}
            </div>
          )}
          <MessageList messages={currentMessages} />
          <PromptInput
            onSend={handleSend}
            onCancel={handleCancel}
            isStreaming={isStreaming}
            disabled={!activeSessionId}
          />
        </div>
      </main>

      {/* Status bar */}
      <footer className="flex h-6 items-center justify-between border-t border-gb-border bg-gb-surface px-4 text-xs text-gb-muted">
        <span>Grok Build Desktop v0.1.0</span>
        <span>{activeSessionId ? `session: ${activeSessionId.slice(0, 12)}...` : "no session"}</span>
      </footer>
    </div>
  );
}
