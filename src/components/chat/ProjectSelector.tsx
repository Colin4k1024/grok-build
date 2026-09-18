import { useState, useEffect, useRef, useCallback } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { listWorktrees, addWorktree, type WorktreeInfo } from "../../lib/tauri";

interface ProjectSelectorProps {
  /** Currently active session's cwd; the selector displays and re-binds it. */
  cwd: string;
  /** Called when the user picks a different worktree; parent typically starts
   *  a new session rooted at that path (Codex behavior). */
  onSwitchProject: (newCwd: string) => void;
  /** Compact = small pill in the TitleBar; full = row in the composer. */
  variant?: "compact" | "full";
}

function projectNameFromPath(path: string): string {
  if (!path) return "No project";
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function ProjectSelector({ cwd, onSwitchProject, variant = "full" }: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [newPath, setNewPath] = useState("");
  const [creating, setCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const setTabCwd = useSessionStore((s) => s.setTabCwd);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open || !cwd) return;
    setLoading(true);
    setError(null);
    listWorktrees(cwd)
      .then(setWorktrees)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, cwd]);

  const handleSelect = useCallback(
    (path: string) => {
      setOpen(false);
      if (path === cwd) return;
      // Re-bind the current session's cwd so subsequent commands run in the
      // chosen worktree, and surface the change to the parent so it can
      // decide whether to spawn a new session.
      if (activeSessionId) setTabCwd(activeSessionId, path);
      onSwitchProject(path);
    },
    [cwd, activeSessionId, setTabCwd, onSwitchProject]
  );

  const handleClear = useCallback(() => {
    setOpen(false);
    if (activeSessionId) setTabCwd(activeSessionId, ".");
    onSwitchProject(".");
  }, [activeSessionId, setTabCwd, onSwitchProject]);

  const handleCreate = useCallback(async () => {
    if (!newBranch.trim() || !newPath.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await addWorktree(cwd, newBranch.trim(), newPath.trim(), true);
      setShowCreate(false);
      setNewBranch("");
      setNewPath("");
      // Refresh the list and switch to the new worktree.
      const list = await listWorktrees(cwd);
      setWorktrees(list);
      handleSelect(newPath.trim());
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }, [cwd, newBranch, newPath, handleSelect]);

  const name = projectNameFromPath(cwd);
  const isCompact = variant === "compact";

  return (
    <div ref={containerRef} className="relative" data-no-drag>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!cwd && worktrees.length === 0}
        className={`flex items-center gap-1.5 rounded text-gb-text-secondary transition-colors hover:bg-gb-surface-hover hover:text-gb-text disabled:opacity-30 ${
          isCompact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-[12px]"
        }`}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        title={cwd}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <svg width={isCompact ? 10 : 12} height={isCompact ? 10 : 12} viewBox="0 0 10 10" fill="currentColor" className="opacity-70">
          <path d="M0 1.5C0 .7.7 0 1.5 0h3l1.5 1.5h2.5C9.3 1.5 10 2.2 10 3v5.5c0 .8-.7 1.5-1.5 1.5h-7C.7 10 0 9.3 0 8.5v-7z" />
        </svg>
        <span className={isCompact ? "max-w-[120px] truncate" : "max-w-[180px] truncate"}>
          {name}
        </span>
        <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" className="opacity-40">
          <path d="M1 3l3 3 3-3z" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-md border border-gb-border/10 bg-gb-surface-solid shadow-lg"
        >
          <div className="border-b border-gb-border/8 px-2.5 py-2">
            <p className="text-[10px] font-medium uppercase text-gb-muted">项目 / Worktree</p>
            <p className="mt-0.5 truncate text-[11px] text-gb-text-secondary">{cwd}</p>
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {loading && <p className="px-2.5 py-2 text-[11px] text-gb-muted">加载中…</p>}
            {error && <p className="px-2.5 py-2 text-[11px] text-gb-red">{error}</p>}
            {!loading && !error && worktrees.length === 0 && (
              <p className="px-2.5 py-2 text-[11px] text-gb-muted">
                未找到 worktree。在 git 仓库中打开目录后，这里会显示其 worktree。
              </p>
            )}
            {worktrees.map((wt) => (
              <button
                key={wt.path}
                role="option"
                aria-selected={wt.path === cwd}
                onClick={() => handleSelect(wt.path)}
                className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-gb-surface-hover ${
                  wt.path === cwd ? "text-gb-accent" : "text-gb-text"
                }`}
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{projectNameFromPath(wt.path)}</span>
                  {wt.branch && (
                    <span className="truncate text-[10px] text-gb-muted">
                      ⎇ {wt.branch}
                      {wt.is_main ? "（主分支）" : ""}
                    </span>
                  )}
                </div>
                {wt.path === cwd && <span className="ml-2 shrink-0 text-gb-accent">✓</span>}
              </button>
            ))}
          </div>
          <div className="border-t border-gb-border/8 py-1">
            {showCreate ? (
              <div className="space-y-1.5 px-2.5 py-1.5">
                <input
                  autoFocus
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="新分支名"
                  className="w-full rounded border border-gb-border bg-gb-bg px-2 py-1 text-[11px] text-gb-text outline-none focus:border-gb-accent/50"
                />
                <input
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="路径（例如 ../my-feature）"
                  className="w-full rounded border border-gb-border bg-gb-bg px-2 py-1 text-[11px] text-gb-text outline-none focus:border-gb-accent/50"
                />
                <div className="flex gap-1">
                  <button
                    onClick={handleCreate}
                    disabled={creating || !newBranch.trim() || !newPath.trim()}
                    className="flex-1 rounded bg-gb-accent px-2 py-1 text-[11px] font-medium text-gb-bg disabled:opacity-40"
                  >
                    {creating ? "创建中…" : "创建"}
                  </button>
                  <button
                    onClick={() => {
                      setShowCreate(false);
                      setNewBranch("");
                      setNewPath("");
                    }}
                    className="flex-1 rounded border border-gb-border/20 px-2 py-1 text-[11px] text-gb-muted hover:bg-gb-surface-hover"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowCreate(true)}
                className="w-full px-2.5 py-1.5 text-left text-[11px] text-gb-accent hover:bg-gb-surface-hover"
              >
                + 新建 worktree…
              </button>
            )}
            <button
              onClick={handleClear}
              className="w-full px-2.5 py-1.5 text-left text-[11px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
            >
              清除项目
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
