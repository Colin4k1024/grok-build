import { useState, useEffect, useRef, useCallback } from "react";

export interface Command {
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

interface Props {
  commands: Command[];
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenDashboard: () => void;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
  onCloseSession: () => void;
  onCompact: () => void;
}

export function CommandPalette({
  commands,
  onNewSession,
  onOpenSettings,
  onOpenDashboard,
  onToggleSidebar,
  onToggleRightPanel,
  onCloseSession,
  onCompact,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build default command list
  const defaultCommands: Command[] = [
    { id: "new-session", title: "New Session", category: "Session", shortcut: "⌘T", action: onNewSession },
    { id: "close-session", title: "Close Current Session", category: "Session", shortcut: "⌘W", action: onCloseSession },
    { id: "compact", title: "Compact Context", category: "Session", action: onCompact },
    { id: "settings", title: "Open Settings", category: "Navigation", action: onOpenSettings },
    { id: "dashboard", title: "Open Dashboard", category: "Navigation", action: onOpenDashboard },
    { id: "toggle-sidebar", title: "Toggle Sidebar", category: "View", action: onToggleSidebar },
    { id: "toggle-right-panel", title: "Toggle Right Panel", category: "View", action: onToggleRightPanel },
    ...commands,
  ];

  // Keyboard listener for Cmd+Shift+P / Cmd+K
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "p") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "k" && !e.shiftKey) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Filter commands
  const filtered = defaultCommands.filter((cmd) => {
    const q = query.toLowerCase();
    return cmd.title.toLowerCase().includes(q) || cmd.category.toLowerCase().includes(q);
  });

  // Group by category
  const categories = [...new Set(filtered.map((c) => c.category))];

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[selectedIdx];
      if (cmd) {
        cmd.action();
        setOpen(false);
      }
    }
  }, [filtered, selectedIdx]);

  if (!open) return null;

  // Flatten for index tracking
  let flatIdx = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-gb-border bg-gb-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="border-b border-gb-border px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="w-full bg-transparent text-sm text-gb-text outline-none placeholder:text-gb-muted"
          />
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <p className="px-4 py-4 text-center text-xs text-gb-muted">No commands found</p>
          ) : (
            categories.map((cat) => (
              <div key={cat}>
                <p className="px-4 py-1 text-[10px] font-semibold uppercase text-gb-muted">{cat}</p>
                {filtered
                  .filter((c) => c.category === cat)
                  .map((cmd) => {
                    flatIdx++;
                    const isSelected = flatIdx === selectedIdx;
                    return (
                      <button
                        key={cmd.id}
                        onClick={() => {
                          cmd.action();
                          setOpen(false);
                        }}
                        onMouseEnter={() => setSelectedIdx(flatIdx)}
                        className={`flex w-full items-center justify-between px-4 py-2 text-xs ${
                          isSelected ? "bg-gb-accent/15 text-gb-text" : "text-gb-muted"
                        }`}
                      >
                        <span>{cmd.title}</span>
                        {cmd.shortcut && (
                          <kbd className="rounded border border-gb-border px-1.5 py-0.5 text-[9px] text-gb-muted">
                            {cmd.shortcut}
                          </kbd>
                        )}
                      </button>
                    );
                  })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gb-border px-4 py-2 text-[10px] text-gb-muted">
          <span className="mr-3">↑↓ Navigate</span>
          <span className="mr-3">↵ Execute</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
