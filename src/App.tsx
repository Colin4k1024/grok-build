import { useState, useEffect, useCallback, useMemo } from "react";
import { Login } from "./pages/Login";
import { useAcpEventListener } from "./hooks/useAcpSession";
import { useTabShortcuts } from "./hooks/useTabShortcuts";
import { useNotifications } from "./hooks/useNotifications";
import { useTheme } from "./hooks/useTheme";
import { useSessionStore, type SessionTab } from "./stores/sessionStore";
import { MessageList } from "./components/chat/MessageList";
import { WorktreeOnboardingBanner } from "./components/chat/WorktreeOnboardingBanner";
import { PromptInput } from "./components/chat/PromptInput";
import { TitleBar } from "./components/layout/TitleBar";
import { Sidebar } from "./components/layout/Sidebar";
import { RightPanel } from "./components/panels/RightPanel";
import { StatusBar } from "./components/panels/StatusBar";
import { ContextBar } from "./components/panels/ContextBar";
import { TabBar } from "./components/session/TabBar";
import { ApprovalCard } from "./components/chat/ApprovalCard";
import { SessionPicker } from "./components/session/SessionPicker";
import { Settings } from "./pages/Settings";
import { Dashboard } from "./pages/Dashboard";
import { Home, type ComposerMode } from "./pages/Home";
import { AuthHandoff } from "./pages/AuthHandoff";
import { WorkspaceAgentsPage } from "./pages/WorkspaceAgentsPage";
import { AutomationsPage } from "./pages/AutomationsPage";
import { CommandPalette } from "./components/layout/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Onboarding } from "./components/Onboarding";
import { ShortcutCheatSheet } from "./components/ShortcutCheatSheet";
import { useAutoReconnect } from "./hooks/useAutoReconnect";
import { useAutoSave } from "./hooks/useAutoSave";
import {
  createSession, sendMessage, cancelSession, closeSession,
  getAuthStatus, logout, getConfig, listSessions, compactSession,
  setSessionModel, resumeSession, addWorktree, listWorktrees,
  type AuthStatus, type ConfigSnapshot, type HistorySession,
  onTrayAction, onConfigChanged,
} from "./lib/tauri";
import type { Command } from "./components/layout/CommandPalette";

export default function App() {
  useAcpEventListener();

  const {
    tabs, messages, activeSessionId, isStreaming,
    setActiveSession, addTab, removeTab, renameTab,
    setStreaming, addUserMessage,
    pendingPermissions, removePendingPermission,
  } = useSessionStore();

  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
  const [showAgentsPage, setShowAgentsPage] = useState(false);
  const [showAutomations, setShowAutomations] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(true);
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  // Explicit home visibility so the Home page is reachable even when tabs exist
  // (e.g. user clicks the app icon / "Home" button). Defaults to true on fresh
  // launch with no tabs; any new/open session hides it.
  const [showHome, setShowHome] = useState(true);

  // When the user creates or activates a session, hide Home.
  useEffect(() => {
    if (activeSessionId) setShowHome(false);
  }, [activeSessionId]);

  // Check if running as a detached single-session window
  const detachedSessionId = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("session")
    : null;

  // Auth handoff route — /auth-handoff or ?auth=handoff.
  const isAuthHandoff = typeof window !== "undefined" && (
    window.location.pathname === "/auth-handoff" ||
    new URLSearchParams(window.location.search).get("auth") === "handoff"
  );

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
      console.error("Failed to check auth status:", e);
      setAuth({ authenticated: false, username: null });
    }
  }, []);

  useEffect(() => {
    refreshAuth();
    if (detachedSessionId) {
      listSessions().then((items) => {
        const item = items.find((s) => s.id === detachedSessionId);
        if (item) {
          addTab({ id: item.id, title: "Detached", cwd: item.cwd, model: "", reasoningEffort: "medium", createdAt: Date.now(), lastActiveAt: Date.now() });
        }
      }).catch(() => {});
    } else {
      // Thread-tab-route-checkpoint: sessionStore persists tabs + activeSessionId
      // via zustand/persist. On boot, tabs whose backend session died with the
      // last quit are re-resumed from their persisted acp session id (codex
      // thread continuity); only tabs without an acp id get pruned.
      const restored = useSessionStore.getState().tabs;
      if (restored.length > 0) {
        listSessions()
          .then(async (live) => {
            const liveIds = new Set(live.map((s) => s.id));
            const dead = restored.filter((t) => !liveIds.has(t.id));

            const unresumable = dead.filter((t) => !t.acpSessionId);
            if (unresumable.length > 0) {
              const drop = new Set(unresumable.map((t) => t.id));
              const tabs = useSessionStore.getState().tabs.filter((t) => !drop.has(t.id));
              useSessionStore.setState({
                tabs,
                activeSessionId:
                  tabs.find((t) => t.id === useSessionStore.getState().activeSessionId)?.id ??
                  tabs[0]?.id ??
                  null,
              });
            }

            // Re-resume sequentially to bound concurrent agent spawns.
            for (const tab of dead.filter((t) => t.acpSessionId)) {
              const current = useSessionStore.getState().tabs.find((t) => t.id === tab.id);
              if (!current) continue; // closed while earlier resumes ran
              try {
                const info = await resumeSession(current.acpSessionId!, current.cwd);
                useSessionStore.getState().finalizeMessages(info.id);
                useSessionStore.getState().rebindTabId(current.id, info.id, info.acp_session_id);
              } catch (e) {
                console.warn("[boot] failed to resume session", current.acpSessionId, e);
                useSessionStore.getState().removeTab(current.id);
              }
            }
          })
          .catch(() => {
            // Backend not up yet — leave the restored tabs alone; they'll fail
            // gracefully on first message and the user can close them.
          });
      }
      getConfig().then(setConfig).catch((e) => setError(String(e)));
    }
  }, [refreshAuth, detachedSessionId, addTab]);

  // Hot-reload config when models are saved
  useEffect(() => {
    const unlisten = onConfigChanged(() => {
      getConfig().then(setConfig).catch(() => {});
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Resume a persisted thread (Home "Recent threads" / Threads picker):
  // session/load restores full agent context and replays the transcript.
  const handleResumeThread = useCallback(async (session: HistorySession) => {
    setCreating(true);
    setError(null);
    try {
      const info = await resumeSession(session.id, session.cwd);
      useSessionStore.getState().finalizeMessages(info.id);
      addTab({
        id: info.id,
        acpSessionId: info.acp_session_id,
        title: session.title.slice(0, 40) + (session.title.length > 40 ? "…" : ""),
        cwd: session.cwd,
        model: session.model || info.models[0]?.id || "",
        reasoningEffort: "medium",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      setShowHome(false);
    } catch (e) { setError(String(e)); }
    finally { setCreating(false); }
  }, [addTab]);

  const handleNewSession = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const info = await createSession(".");
      addTab({
        id: info.id,
        acpSessionId: info.acp_session_id,
        title: `Session ${tabs.length + 1}`,
        cwd: info.cwd,
        model: info.models[0]?.id || "",
        reasoningEffort: "medium",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    } catch (e) { setError(String(e)); }
    finally { setCreating(false); }
  }, [addTab, tabs.length]);

  // Start a session rooted at a chosen project directory.
  const handleNewSessionInDir = useCallback(async (cwd: string) => {
    setCreating(true);
    setError(null);
    try {
      const info = await createSession(cwd);
      const dirName = info.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || info.cwd;
      addTab({
        id: info.id,
        acpSessionId: info.acp_session_id,
        title: dirName,
        cwd: info.cwd,
        model: info.models[0]?.id || "",
        reasoningEffort: "medium",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      setShowHome(false);
    } catch (e) { setError(String(e)); }
    finally { setCreating(false); }
  }, [addTab]);

  // Home page: start a session with an initial prompt, in chat or agent mode.
  // The mode is forwarded as a prefix in the first message so the backend
  // session knows whether to run autonomously (agent) or conversationally.
  const handleStartFromHome = useCallback(async (prompt: string, mode: ComposerMode, images: { data: string; mime_type: string }[] = []) => {
    setCreating(true);
    setError(null);
    try {
      const info = await createSession(".");
      addTab({
        id: info.id,
        acpSessionId: info.acp_session_id,
        title: prompt ? prompt.slice(0, 30) + (prompt.length > 30 ? "…" : "") : `Session ${tabs.length + 1}`,
        cwd: info.cwd,
        model: info.models[0]?.id || "",
        reasoningEffort: "medium",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      setShowHome(false);
      if (prompt.trim() || images.length > 0) {
        // Agent mode: prepend a system-style instruction so the backend agent
        // runs autonomously; Chat mode sends the prompt as-is.
        const outbound = mode === "agent"
          ? `[Agent mode] ${prompt}`
          : prompt;
        addUserMessage(info.id, outbound);
        setStreaming(true);
        try {
          await sendMessage(info.id, outbound, images);
        } catch (e) {
          setError(String(e));
          setStreaming(false);
        }
      }
    } catch (e) { setError(String(e)); }
    finally { setCreating(false); }
  }, [addTab, addUserMessage, setStreaming, tabs.length]);

  // Cmd+N / Ctrl+N -> New Session
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleNewSession]);

  const handleCloseSession = useCallback(async (id: string) => {
    const msgs = messages[id] || [];
    if (msgs.length > 0 || isStreaming) {
      setConfirmClose(id);
      return;
    }
    await performClose(id);
  }, [messages, isStreaming]);

  const performClose = useCallback(async (id: string) => {
    try { await closeSession(id); } catch (e) { console.error(e); }
    removeTab(id);
    setConfirmClose(null);
  }, [removeTab]);

  const handleForkSession = useCallback(async (id: string) => {
    const sourceTab = tabs.find((t) => t.id === id);
    if (!sourceTab) return;
    setCreating(true);
    try {
      const info = await createSession(sourceTab.cwd);
      addTab({
        id: info.id,
        acpSessionId: info.acp_session_id,
        title: `Fork of ${sourceTab.title}`,
        cwd: info.cwd,
        model: sourceTab.model,
        reasoningEffort: sourceTab.reasoningEffort,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    } catch (e) { setError(String(e)); }
    finally { setCreating(false); }
  }, [tabs, addTab]);

  useTabShortcuts({
    onNewSession: handleNewSession,
    onCloseActiveTab: () => {
      if (activeSessionId) handleCloseSession(activeSessionId);
    },
  });

  useNotifications();
  useTheme();
  useAutoReconnect();
  useAutoSave();

  // Handle tray "new session" action
  useEffect(() => {
    const unlisten = onTrayAction((action) => {
      if (action === "new-session") {
        handleNewSession();
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const handleSend = useCallback(async (message: string, images: { data: string; mime_type: string }[] = []) => {
    let sid = activeSessionId;
    // Auto-create a session when the user sends without one — makes the
    // flow seamless.
    if (!sid) {
      try {
        const info = await createSession(".");
        addTab({
          id: info.id,
          acpSessionId: info.acp_session_id,
          title: "Untitled",
          cwd: info.cwd,
          model: info.models[0]?.id || "",
          reasoningEffort: "medium",
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        });
        setShowHome(false);
        sid = info.id;
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    addUserMessage(sid, message);
    const tab = tabs.find((t) => t.id === sid);
    if (tab && tab.title.startsWith("Session")) {
      renameTab(sid, message.slice(0, 30) + (message.length > 30 ? "…" : ""));
    }
    setStreaming(true);
    try { await sendMessage(sid, message, images); }
    catch (e) { setError(String(e)); setStreaming(false); }
  }, [activeSessionId, addTab, addUserMessage, setStreaming, tabs, renameTab]);


  const handleCancel = useCallback(async () => {
    if (!activeSessionId) return;
    try { await cancelSession(activeSessionId); }
    catch (e) { setError(String(e)); }
    setStreaming(false);
  }, [activeSessionId, setStreaming]);

  const handleLogout = useCallback(async () => {
    try { await logout(); }
    catch (e) { setError(String(e)); }
    setAuth({ authenticated: false, username: null });
    setActiveSession(null);
  }, [setActiveSession]);

  // Real project switch (ISS-060): the live agent is bound to the cwd it was
  // spawned with, so switching means spawning a fresh session in the new
  // directory and rebinding the tab in place (title + transcript preserved).
  // A busy thread is never silently re-anchored — ask whether to stop it and
  // switch, or leave it running and open a new thread in the chosen project.
  const handleSwitchProject = useCallback(async (newCwd: string) => {
    if (!activeSessionId) return;
    const store = useSessionStore.getState();
    if (store.isStreaming) {
      const stopAndSwitch = window.confirm(
        "A task is still running in this thread.\n\n" +
          "OK — stop it and switch project\n" +
          "Cancel — keep it running and open a new thread in the project"
      );
      if (!stopAndSwitch) {
        try {
          const info = await createSession(newCwd);
          const dirName = info.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || info.cwd;
          addTab({
            id: info.id,
            acpSessionId: info.acp_session_id,
            title: dirName,
            cwd: info.cwd,
            model: info.models[0]?.id || "",
            reasoningEffort: "medium",
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
          });
          setShowHome(false);
        } catch (e) { setError(String(e)); }
        return;
      }
      try { await cancelSession(activeSessionId); } catch { /* already idle */ }
      store.setStreaming(false);
    }
    setCreating(true);
    setError(null);
    try {
      const info = await createSession(newCwd);
      // Dispose the old agent only after the new session is live — a failed
      // spawn must not leave the thread without any backend.
      try { await closeSession(activeSessionId); } catch (e) { console.error(e); }
      const previous = store.tabs.find((t) => t.id === activeSessionId);
      store.rebindTabId(activeSessionId, info.id, info.acp_session_id);
      store.setTabCwd(info.id, info.cwd);
      if (previous?.model) store.setTabModel(info.id, previous.model);
    } catch (e) { setError(String(e)); }
    finally { setCreating(false); }
  }, [activeSessionId, addTab]);

  // Queue the current draft for the next turn (codex Tab semantics); flushed
  // automatically by the ACP listener on TurnComplete.
  const handleQueue = useCallback((text: string) => {
    if (activeSessionId) useSessionStore.getState().enqueueQueuedPrompt(activeSessionId, text);
  }, [activeSessionId]);

  // Model/effort from the composer control — persists per tab and applies to
  // the live agent immediately.
  const handleModelEffortChange = useCallback((model: string, effort: SessionTab["reasoningEffort"]) => {
    if (!activeSessionId) return;
    const store = useSessionStore.getState();
    store.setTabModel(activeSessionId, model);
    store.setTabEffort(activeSessionId, effort);
    setSessionModel(activeSessionId, model).catch((e) => setError(String(e)));
  }, [activeSessionId]);

  // Work mode: worktree creates an isolated checkout for the picked branch and
  // re-anchors the session there (reusing the project-switch path); local
  // switches back to the main checkout.
  const handleWorkModeChange = useCallback(async (mode: "local" | "worktree", branch?: string) => {
    if (!activeSessionId) return;
    const store = useSessionStore.getState();
    const tab = store.tabs.find((t) => t.id === activeSessionId);
    if (!tab) return;
    store.setTabWorkMode(activeSessionId, mode, branch);
    if (mode === "worktree" && branch) {
      const segs = tab.cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
      const repo = segs.pop() || "repo";
      const parent = segs.join("/") || "/";
      const wtPath = `${parent}/${repo}-wt-${branch.split("/").pop()}`;
      try {
        await addWorktree(tab.cwd, branch, wtPath, true);
        await handleSwitchProject(wtPath);
      } catch (e) { setError(String(e)); }
    } else if (mode === "local") {
      try {
        const wts = await listWorktrees(tab.cwd);
        const main = wts.find((w) => w.is_main);
        if (main && main.path !== tab.cwd) await handleSwitchProject(main.path);
      } catch { /* not a git repo — stay put */ }
    }
  }, [activeSessionId, handleSwitchProject]);

  // Commands surfaced in the command palette: per-session switches (open any
  // open tab, jump to a recent model), plus global navigation helpers. The
  // palette's built-ins (New Session / Close / Compact / Settings / Dashboard /
  // toggle sidebars) are supplied via the dedicated onX props below.
  const paletteCommands: Command[] = useMemo(() => {
    const cmds: Command[] = [];

    // Switch to each open session. Hides Home so the chat view becomes visible.
    for (const tab of tabs) {
      cmds.push({
        id: `switch-${tab.id}`,
        title: `Switch to: ${tab.title}`,
        category: "Session",
        action: () => {
          setActiveSession(tab.id);
          setShowHome(false);
        },
      });
    }

    // Set model on the active session.
    if (activeSessionId && config) {
      const activeTab = tabs.find((t) => t.id === activeSessionId);
      for (const m of config.models.filter((mm) => !mm.hidden)) {
        if (m.id === activeTab?.model) continue;
        cmds.push({
          id: `model-${m.id}`,
          title: `Use model: ${m.name}`,
          category: "Model",
          action: () => {
            if (!activeSessionId) return;
            useSessionStore.getState().setTabModel(activeSessionId, m.id);
            setSessionModel(activeSessionId, m.id).catch(console.error);
          },
        });
      }
    }

    // Settings navigation — jump to a specific tab from the palette.
    const settingsTargets: { id: string; title: string; tab: string }[] = [
      { id: "settings-models", title: "Settings: Models", tab: "models" },
      { id: "settings-apikeys", title: "Settings: API Keys", tab: "apikeys" },
      { id: "settings-mcp", title: "Settings: MCP Servers", tab: "mcp" },
      { id: "settings-plugins", title: "Settings: Plugins", tab: "plugins" },
      { id: "settings-worktrees", title: "Settings: Worktrees", tab: "worktrees" },
      { id: "settings-appearance", title: "Settings: Appearance", tab: "appearance" },
      { id: "settings-permissions", title: "Settings: Permissions", tab: "permissions" },
      { id: "settings-agent", title: "Settings: Agent", tab: "agent" },
      { id: "settings-trusted", title: "Settings: Trusted Folders", tab: "trusted" },
      { id: "settings-general", title: "Settings: General", tab: "general" },
    ];
    for (const s of settingsTargets) {
      cmds.push({
        id: s.id,
        title: s.title,
        category: "Settings",
        action: () => {
          setSettingsTab(s.tab);
          setShowSettings(true);
        },
      });
    }

    // Go home (fresh composer).
    cmds.push({
      id: "go-home",
      title: "Go Home",
      category: "Navigation",
      action: () => setShowHome(true),
    });

    return cmds;
  }, [tabs, activeSessionId, config, setActiveSession]);

  if (auth && !auth.authenticated) return <Login onLoginSuccess={refreshAuth} />;
  if (isAuthHandoff) return <AuthHandoff />;
  if (!auth) {
    return (
      <div className="flex h-full items-center justify-center bg-gb-bg">
        <p className="text-gb-muted">Loading...</p>
      </div>
    );
  }

  const currentMessages = activeSessionId ? (messages[activeSessionId] || []) : [];

  // Detached window: render only the chat area
  if (detachedSessionId) {
    return (
      <div className="flex h-full flex-col text-gb-text">
        <header className="flex h-9 shrink-0 items-center border-b border-gb-border bg-gb-surface px-3">
          <span className="text-xs font-medium text-gb-text">Detached Session</span>
        </header>
        <MessageList messages={currentMessages} />
        <PromptInput
          onSend={handleSend}
          onCancel={handleCancel}
          isStreaming={isStreaming}
          disabled={!activeSessionId}
        />
      </div>
    );
  }

  if (showAutomations) {
    return <AutomationsPage onClose={() => setShowAutomations(false)} />;
  }

  if (showAgentsPage) {
    return (
      <WorkspaceAgentsPage
        onClose={() => setShowAgentsPage(false)}
        onOpenSession={(id) => {
          setActiveSession(id);
          setShowAgentsPage(false);
        }}
      />
    );
  }

  if (showDashboard) {
    return (
      <Dashboard
        onClose={() => setShowDashboard(false)}
        onOpenSession={() => setShowDashboard(false)}
      />
    );
  }

  if (showSettings) {
    return <Settings onClose={() => { setShowSettings(false); setSettingsTab(undefined); }} initialTab={settingsTab} />;
  }

  return (
    <ErrorBoundary>
    <div className="flex h-full flex-col text-gb-text">
      <TitleBar
        auth={auth}
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
          onNewSessionInDir={handleNewSessionInDir}
          creating={creating}
          onForkSession={handleForkSession}
          onCloseSession={handleCloseSession}
          onOpenThreads={() => setShowPicker(true)}
          onOpenSettings={() => setShowSettings(true)}
          onOpenDashboard={() => setShowDashboard(true)}
          onOpenAgentsPage={() => setShowAgentsPage(true)}
          onOpenAutomations={() => setShowAutomations(true)}
        />

        <main className="flex flex-1 flex-col overflow-hidden">
          {tabs.length > 0 && (
            <TabBar
              onNewSession={handleNewSession}
              onCloseSession={handleCloseSession}
              onForkSession={handleForkSession}
            />
          )}

          {error && (
            <div className="flex items-center gap-2 border-b border-gb-red/20 bg-gb-red/5 px-4 py-2 text-xs text-gb-red backdrop-blur-xl">
              <span className="flex-1">{error}</span>
              <button className="text-gb-red/60 hover:text-gb-red" onClick={() => setError(null)}>✕</button>
            </div>
          )}

          {showHome ? (
            <Home
              onStart={handleStartFromHome}
              onOpenSession={(id) => {
                setActiveSession(id);
                setShowHome(false);
              }}
              onResumeThread={handleResumeThread}
              creating={creating}
            />
          ) : (
            <>
              <WorktreeOnboardingBanner />
              <MessageList messages={currentMessages} />
              {activeSessionId && (pendingPermissions[activeSessionId] || []).map((perm) => (
                <ApprovalCard
                  key={perm.requestId}
                  sessionId={activeSessionId}
                  requestId={perm.requestId}
                  toolName={perm.toolName}
                  command={perm.command}
                  options={perm.options}
                  onResolved={() => removePendingPermission(activeSessionId!, perm.requestId)}
                />
              ))}
              <ContextBar />
              <PromptInput
                onSend={handleSend}
                onCancel={handleCancel}
                isStreaming={isStreaming}
                disabled={false}
                cwd={activeSessionId ? tabs.find((t) => t.id === activeSessionId)?.cwd : undefined}
                onSwitchProject={handleSwitchProject}
                config={config}
                onModelEffortChange={handleModelEffortChange}
                onWorkModeChange={handleWorkModeChange}
                onQueue={handleQueue}
              />
            </>
          )}
        </main>

        <RightPanel collapsed={responsiveRightCollapsed} />
      </div>

      <StatusBar
        connected={auth.authenticated}
        workingDir={activeSessionId ? tabs.find((t) => t.id === activeSessionId)?.cwd || "." : "."}
        sandboxMode={false}
        sessionCount={tabs.length}
        streaming={isStreaming}
      />

      {showPicker && (
        <SessionPicker onClose={() => setShowPicker(false)} />
      )}

      {confirmClose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-80 rounded-xl border border-gb-border bg-gb-surface-solid p-6 text-center shadow-2xl">
            <p className="mb-2 text-sm font-medium text-gb-text">Close this session?</p>
            <p className="mb-4 text-xs text-gb-muted">
              Messages in this session will be lost. The agent process will be terminated.
            </p>
            <div className="flex gap-2">
              <button
                className="flex-1 rounded-md border border-gb-border/10 px-3 py-2 text-[12px] text-gb-muted hover:bg-gb-surface-hover"
                onClick={() => setConfirmClose(null)}
              >
                Cancel
              </button>
              <button
                className="flex-1 rounded-md bg-gb-red px-3 py-2 text-[12px] font-medium text-white hover:opacity-80"
                onClick={() => performClose(confirmClose)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <CommandPalette
        commands={paletteCommands}
        onNewSession={handleNewSession}
        onOpenSettings={() => setShowSettings(true)}
        onOpenDashboard={() => setShowDashboard(true)}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onToggleRightPanel={() => setRightPanelCollapsed((v) => !v)}
        onCloseSession={() => { if (activeSessionId) handleCloseSession(activeSessionId); }}
        onCompact={() => { if (activeSessionId) compactSession(activeSessionId).catch(console.error); }}
      />
      <Onboarding onComplete={() => {}} />
      <ShortcutCheatSheet />
    </div>
    </ErrorBoundary>
  );
}
