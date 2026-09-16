import { useState, useEffect, useCallback } from "react";
import { Login } from "./pages/Login";
import { useAcpEventListener } from "./hooks/useAcpSession";
import { useSessionStore } from "./stores/sessionStore";
import { MessageList } from "./components/chat/MessageList";
import { PromptInput } from "./components/chat/PromptInput";
import { TitleBar } from "./components/layout/TitleBar";
import { Sidebar } from "./components/layout/Sidebar";
import { RightPanel } from "./components/panels/RightPanel";
import { StatusBar } from "./components/panels/StatusBar";
import { createSession, sendMessage, cancelSession, getAuthStatus, logout, getConfig, type AuthStatus, type ConfigSnapshot } from "./lib/tauri";

export default function App() {
  useAcpEventListener();

  const { messages, activeSessionId, isStreaming, setActiveSession, setStreaming, addUserMessage, clearMessages } = useSessionStore();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Layout state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(true);
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);

  // Responsive: collapse sidebar on narrow windows
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const responsiveSidebarCollapsed = sidebarCollapsed || windowWidth < 1000;
  const responsiveRightCollapsed = rightPanelCollapsed || windowWidth < 1200;

  const refreshAuth = useCallback(async () => {
    try {
      const status = await getAuthStatus();
      setAuth(status);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refreshAuth();
    getConfig().then(setConfig).catch((e) => setError(String(e)));
  }, [refreshAuth]);

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

  const handleLogout = useCallback(async () => {
    try {
      await logout();
      setAuth({ authenticated: false, username: null });
      setActiveSession(null);
    } catch (e) {
      setError(String(e));
    }
  }, [setActiveSession]);

  if (auth && !auth.authenticated) {
    return <Login onLoginSuccess={refreshAuth} />;
  }

  if (!auth) {
    return (
      <div className="flex h-full items-center justify-center bg-gb-bg">
        <p className="text-gb-muted">Loading...</p>
      </div>
    );
  }

  const currentMessages = activeSessionId ? (messages[activeSessionId] || []) : [];
  const sessionCount = Object.keys(messages).length;

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      <TitleBar
        auth={auth}
        config={config}
        onLogout={handleLogout}
        onNewSession={handleNewSession}
        creating={creating}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onToggleRightPanel={() => setRightPanelCollapsed((v) => !v)}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          collapsed={responsiveSidebarCollapsed}
          onNewSession={handleNewSession}
          creating={creating}
        />

        {/* Center: chat area */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {error && (
            <div className="flex items-center gap-2 border-b border-gb-red/30 bg-gb-red/10 px-4 py-2 text-xs text-gb-red">
              <span className="flex-1">{error}</span>
              <button
                className="text-gb-red/60 hover:text-gb-red"
                onClick={() => setError(null)}
              >
                ✕
              </button>
            </div>
          )}
          <MessageList messages={currentMessages} />
          <PromptInput
            onSend={handleSend}
            onCancel={handleCancel}
            isStreaming={isStreaming}
            disabled={!activeSessionId}
          />
        </main>

        <RightPanel collapsed={responsiveRightCollapsed} />
      </div>

      <StatusBar
        connected={auth.authenticated}
        workingDir="."
        sandboxMode={false}
        sessionCount={sessionCount}
        streaming={isStreaming}
      />
    </div>
  );
}
