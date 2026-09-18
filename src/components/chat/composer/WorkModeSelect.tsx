import { useState, useRef, useEffect, useCallback } from "react";
import { addWorktree, listBranches } from "../../../lib/tauri";
import type { WorkMode } from "../../../stores/sessionStore";

interface Props {
  cwd: string;
  mode: WorkMode;
  branch?: string;
  /** Called with the desired mode. For worktree, `branch` is included and the
   *  parent is expected to create the worktree and re-anchor the session. */
  onChange: (mode: WorkMode, branch?: string) => void;
  onError: (message: string) => void;
}

/** Work-mode picker: Work locally (current checkout) or in an isolated
 *  worktree on a chosen branch — codex composer semantics. */
export function WorkModeSelect({ cwd, mode, branch, onChange, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      setBranches([]);
      listBranches(cwd).then(setBranches).catch(() => {});
    }
  }, [open, cwd]);

  const createWorktree = useCallback(
    async (name: string) => {
      if (!name.trim()) return;
      setCreating(true);
      try {
        // Sibling directory keeps the worktree out of the main checkout.
        const segs = cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
        const repo = segs.pop() || "repo";
        const parent = segs.join("/") || "/";
        const safe = name.trim().replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/^\/+|\/+$/g, "");
        const wtPath = `${parent}/${repo}-wt-${safe.split("/").pop()}`;
        await addWorktree(cwd, safe, wtPath, true);
        onChange("worktree", safe);
        setOpen(false);
      } catch (e) {
        onError(String(e));
      } finally {
        setCreating(false);
      }
    },
    [cwd, onChange, onError]
  );

  const label = mode === "worktree" ? `Worktree${branch ? ` · ${branch}` : ""}` : "本地工作";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gb-text-secondary transition-colors hover:bg-gb-surface-hover hover:text-gb-text"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="工作模式"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="opacity-70">
          <path d="M3 1v6a2 2 0 002 2h5M8 6l2.5 3L8 12" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="3" cy="1.5" r="1.2" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        <span className="max-w-[140px] truncate">{label}</span>
        <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" className="opacity-40"><path d="M1 3l3 3 3-3z" /></svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-50 mb-1.5 w-64 overflow-hidden rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg"
        >
          <button
            role="option"
            aria-selected={mode === "local"}
            onClick={() => { onChange("local"); setOpen(false); }}
            className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-gb-surface-hover ${
              mode === "local" ? "text-gb-accent" : "text-gb-text"
            }`}
          >
            <span>本地工作</span>
            {mode === "local" && <span className="text-gb-accent">✓</span>}
          </button>

          <div className="border-t border-gb-border/8 px-2.5 py-2">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-gb-muted">
              Worktree — isolated checkout per branch
            </p>
            {mode === "worktree" && (
              <button
                onClick={() => { onChange("local"); setOpen(false); }}
                className="mb-1.5 w-full rounded border border-gb-border/20 px-2 py-1 text-left text-[11px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
              >
                Back to local checkout
              </button>
            )}
            {creating ? (
              <div className="space-y-1">
                <input
                  autoFocus
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") createWorktree(branchName); }}
                  placeholder="分支名（例如 fix/login-bug）"
                  className="w-full rounded border border-gb-border bg-gb-bg px-2 py-1 text-[11px] text-gb-text outline-none focus:border-gb-accent/50"
                />
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full rounded px-1 py-0.5 text-left text-[11px] text-gb-accent hover:bg-gb-surface-hover"
              >
                + New worktree from branch…
              </button>
            )}
            {branches.length > 0 && !creating && (
              <div className="mt-1 max-h-28 overflow-y-auto">
                {branches.slice(0, 30).map((b) => (
                  <button
                    key={b}
                    onClick={() => createWorktree(b)}
                    className="block w-full truncate rounded px-1 py-0.5 text-left text-[11px] text-gb-text-secondary hover:bg-gb-surface-hover hover:text-gb-text"
                    title={`Create worktree for ${b}`}
                  >
                    ⎇ {b}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
