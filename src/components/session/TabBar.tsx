import { useState, useRef, useCallback } from "react";
import { useSessionStore, type SessionTab } from "../../stores/sessionStore";
import { openSessionInNewWindow } from "../../lib/tauri";

interface TabBarProps {
  onNewSession: () => void;
  onCloseSession: (id: string) => void;
  onForkSession: (id: string) => void;
}

interface ContextMenu {
  x: number;
  y: number;
  tabId: string;
}

export function TabBar({ onNewSession, onCloseSession, onForkSession }: TabBarProps) {
  const { tabs, activeSessionId, setActiveSession, renameTab, closeOtherTabs, reorderTabs } = useSessionStore();
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, tab: SessionTab) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
  }, []);

  const startRename = useCallback((tabId: string, currentTitle: string) => {
    setEditingId(tabId);
    setEditValue(currentTitle);
    setContextMenu(null);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId && editValue.trim()) {
      renameTab(editingId, editValue.trim());
    }
    setEditingId(null);
  }, [editingId, editValue, renameTab]);

  const handleExport = useCallback((tabId: string) => {
    const { messages } = useSessionStore.getState();
    const msgs = messages[tabId] || [];
    const lines = msgs.map((m) => {
      if (m.role === "user") return `## User\n${m.content}`;
      if (m.role === "assistant") return `## Assistant\n${m.content}`;
      return `## Tool: ${m.toolName}\n${m.content}`;
    });
    const blob = new Blob([lines.join("\n\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${tabId}.md`;
    a.click();
    URL.revokeObjectURL(url);
    setContextMenu(null);
  }, []);

  const handleOpenInWindow = useCallback((tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) openSessionInNewWindow(tabId, tab.title);
    setContextMenu(null);
  }, [tabs]);

  const handleDragStart = (index: number) => setDragIndex(index);
  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== index) {
      reorderTabs(dragIndex, index);
      setDragIndex(index);
    }
  };

  return (
    <>
      <div className="flex items-center gap-0.5 border-b border-gb-border/8 px-1.5 py-1">
        <div className="flex flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              draggable={editingId !== tab.id}
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onContextMenu={(e) => handleContextMenu(e, tab)}
              onClick={() => setActiveSession(tab.id)}
              className={`group flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md px-3 py-1.5 text-xs transition-colors ${
                activeSessionId === tab.id
                  ? "bg-gb-surface text-gb-text"
                  : "text-gb-muted hover:bg-gb-surface/50 hover:text-gb-text"
              }`}
            >
              {editingId === tab.id ? (
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="w-24 rounded bg-gb-bg px-1 py-0 text-[12px] text-gb-text outline-none"
                />
              ) : (
                <>
                  <span className="max-w-[120px] truncate">{tab.title}</span>
                  {tab.id === activeSessionId && useSessionStore.getState().isStreaming && (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gb-accent" />
                  )}
                  <button
                    className="ml-1 rounded p-0.5 text-gb-muted opacity-0 hover:bg-gb-border hover:text-gb-red group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseSession(tab.id);
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <button
          className="shrink-0 rounded-md p-1 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          onClick={onNewSession}
          title="New session (Cmd+N)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>

      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div
            ref={menuRef}
            className="fixed z-50 w-44 rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg animate-fade-in"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <MenuItem label="Rename" onClick={() => {
              const tab = tabs.find((t) => t.id === contextMenu.tabId);
              if (tab) startRename(tab.id, tab.title);
            }} />
            <MenuItem label="Fork session" onClick={() => {
              onForkSession(contextMenu.tabId);
              setContextMenu(null);
            }} />
            <MenuItem label="Open in new window" onClick={() => handleOpenInWindow(contextMenu.tabId)} />
            <MenuItem label="Export as Markdown" onClick={() => handleExport(contextMenu.tabId)} />
            <div className="my-1 border-t border-gb-border" />
            <MenuItem label="Close" onClick={() => {
              onCloseSession(contextMenu.tabId);
              setContextMenu(null);
            }} />
            <MenuItem label="Close others" danger onClick={() => {
              closeOtherTabs(contextMenu.tabId);
              setContextMenu(null);
            }} />
          </div>
        </>
      )}
    </>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={`w-full px-2.5 py-1.5 text-left text-[12px] hover:bg-gb-surface-hover ${
        danger ? "text-gb-red" : "text-gb-text"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
