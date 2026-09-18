import { useState, useRef, useEffect, useCallback } from "react";
import { listWorktrees } from "../../../lib/tauri";

interface Props {
  cwd: string;
  /** Current branch (of the active checkout / worktree). */
  branch?: string;
  /** Only meaningful in worktree mode — picks the branch to isolate on. */
  onPickBranch: (branch: string) => void;
}

/** Branch selector. In local mode the checkout branch is read-only (the agent
 *  manages checkouts); in worktree mode picking a branch creates/reuses that
 *  worktree. */
export function BranchSelect({ cwd, branch, onPickBranch }: Props) {
  // Stale-response guard: only the latest cwd's results may land (review r1-leftover).
  const genRef = useRef(0);
  const [open, setOpen] = useState(false);
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

  const load = useCallback(() => {
    const gen = ++genRef.current;
    listWorktrees(cwd)
      .then((wts) => {
        if (gen !== genRef.current) return; // stale cwd response — drop
        const seen = new Set<string>();
        const list: string[] = [];
        for (const wt of wts) {
          if (wt.branch && !seen.has(wt.branch)) {
            seen.add(wt.branch);
            list.push(wt.branch);
          }
        }
        setBranches(list);
      })
      .catch(() => {
        if (gen === genRef.current) setBranches([]);
      });
  }, [cwd]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gb-text-secondary transition-colors hover:bg-gb-surface-hover hover:text-gb-text"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="分支"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="opacity-70">
          <path d="M4 2v5a2 2 0 002 2h3" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="4" cy="2" r="1.3" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="10" cy="9" r="1.3" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        <span className="max-w-[110px] truncate">{branch || "branch"}</span>
        <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" className="opacity-40"><path d="M1 3l3 3 3-3z" /></svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-50 mb-1.5 w-52 max-h-56 overflow-y-auto rounded-md border border-gb-border/10 bg-gb-surface-solid py-0.5 shadow-lg"
        >
          {branches.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-gb-muted">此处未找到 git 分支。</p>
          )}
          {branches.map((b) => (
            <button
              key={b}
              role="option"
              aria-selected={b === branch}
              onClick={() => { onPickBranch(b); setOpen(false); }}
              className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-gb-surface-hover ${
                b === branch ? "text-gb-accent" : "text-gb-text"
              }`}
            >
              <span className="truncate">⎇ {b}</span>
              {b === branch && <span className="text-gb-accent">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
