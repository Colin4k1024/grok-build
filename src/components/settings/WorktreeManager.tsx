import { useState, useEffect, useCallback } from "react";
import { listWorktrees, addWorktree, removeWorktree, listBranches, createSession } from "../../lib/tauri";
import type { WorktreeInfo } from "../../lib/tauri";
import { useSessionStore } from "../../stores/sessionStore";

export function WorktreeManager() {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [creating, setCreating] = useState(false);

  const cwd = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeSessionId);
    return tab?.cwd || ".";
  });
  const addTab = useSessionStore((s) => s.addTab);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wts, brs] = await Promise.all([
        listWorktrees(cwd),
        listBranches(cwd),
      ]);
      setWorktrees(wts);
      setBranches(brs);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }, [cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleCreate() {
    if (!selectedBranch || !worktreePath) return;
    setCreating(true);
    setError(null);
    try {
      const fullPath = worktreePath.startsWith("/")
        ? worktreePath
        : `${cwd.replace(/\/[^/]+$/, "")}/${worktreePath}`;
      const isNew = !branches.includes(selectedBranch);
      await addWorktree(cwd, selectedBranch, fullPath, isNew);
      // Auto-create a new session in the worktree
      const info = await createSession(fullPath);
      addTab({
        id: info.id,
        title: selectedBranch,
        cwd: fullPath,
        model: info.models[0]?.id || "",
        reasoningEffort: "medium",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      setShowForm(false);
      setSelectedBranch("");
      setWorktreePath("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
    setCreating(false);
  }

  async function handleRemove(path: string, isMain: boolean) {
    if (isMain) {
      setError("Cannot remove the main worktree");
      return;
    }
    if (!confirm(`Remove worktree at ${path}?`)) return;
    try {
      await removeWorktree(cwd, path, false);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gb-text">Git Worktrees</h3>
          <p className="text-[10px] text-gb-muted">Working directory: <code>{cwd}</code></p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded border border-gb-border px-3 py-1 text-xs text-gb-muted hover:bg-gb-surface hover:text-gb-text"
        >
          {showForm ? "Cancel" : "+ New Worktree"}
        </button>
      </div>

      {error && (
        <div className="rounded border border-gb-red/30 bg-gb-red/10 px-3 py-2 text-xs text-gb-red">{error}</div>
      )}

      {showForm && (
        <div className="rounded-lg border border-gb-border bg-gb-surface p-4 space-y-3">
          <div>
            <label className="mb-1 block text-[10px] font-medium text-gb-muted">Branch</label>
            <input
              list="branch-list"
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              placeholder="feature/my-feature"
              className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-xs text-gb-text"
            />
            <datalist id="branch-list">
              {branches.map((b) => <option key={b} value={b} />)}
            </datalist>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-gb-muted">Worktree Path (relative or absolute)</label>
            <input
              value={worktreePath}
              onChange={(e) => setWorktreePath(e.target.value)}
              placeholder="../grok-build-feature"
              className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-xs text-gb-text"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !selectedBranch || !worktreePath}
              className="rounded bg-gb-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create & Open Session"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gb-muted">Loading worktrees...</p>
      ) : worktrees.length === 0 ? (
        <p className="py-4 text-center text-xs text-gb-muted">No worktrees found</p>
      ) : (
        <div className="space-y-2">
          {worktrees.map((wt) => (
            <div key={wt.path} className="rounded-lg border border-gb-border bg-gb-surface p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gb-text">{wt.branch || "(detached)"}</span>
                  {wt.is_main && (
                    <span className="rounded bg-gb-accent/15 px-1.5 py-0.5 text-[9px] text-gb-accent">MAIN</span>
                  )}
                </div>
                {!wt.is_main && (
                  <button
                    onClick={() => handleRemove(wt.path, wt.is_main)}
                    className="text-[10px] text-gb-red hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="mt-1 text-[10px] text-gb-muted">
                <div className="truncate"><code>{wt.path}</code></div>
                {wt.head && <div className="truncate text-gb-muted">HEAD: {wt.head.slice(0, 8)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
