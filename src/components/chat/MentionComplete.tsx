import { useState, useEffect, useMemo, useRef } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { listWorktrees, type WorktreeInfo } from "../../lib/tauri";

export interface MentionItem {
  kind: "file" | "project" | "skill";
  id: string;
  label: string;
  detail?: string;
}

interface MentionCompleteProps {
  /** The text after '@' that the user has typed so far. */
  query: string;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
  anchorBottom?: number;
  cwd: string;
}

const BUILTIN_SKILLS: MentionItem[] = [
  { kind: "skill", id: "explore", label: "explore", detail: "Search the codebase" },
  { kind: "skill", id: "plan", label: "plan", detail: "Design an implementation plan" },
  { kind: "skill", id: "review", label: "review", detail: "Review a recent change" },
  { kind: "skill", id: "test", label: "test", detail: "Run project tests" },
];

export function MentionComplete({ query, onSelect, onClose, anchorBottom = 140, cwd }: MentionCompleteProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const tabs = useSessionStore((s) => s.tabs);

  // Pull worktrees once when the dropdown opens so @project completions are
  // fresh. Failure is non-fatal — we just skip the project group.
  useEffect(() => {
    if (!cwd) return;
    listWorktrees(cwd).then(setWorktrees).catch(() => {});
  }, [cwd]);

  const items = useMemo(() => {
    const q = query.toLowerCase();
    const out: MentionItem[] = [];

    // @project — worktrees
    for (const wt of worktrees) {
      const name = wt.path.split(/[/\\]/).filter(Boolean).pop() || wt.path;
      if (name.toLowerCase().includes(q) || wt.branch.toLowerCase().includes(q)) {
        out.push({
          kind: "project",
          id: wt.path,
          label: name,
          detail: wt.branch,
        });
      }
    }

    // @file — surface paths of open tabs (cwd) as a proxy until we wire a real
    // file-index search.
    const seen = new Set<string>();
    for (const tab of tabs) {
      if (!tab.cwd || seen.has(tab.cwd)) continue;
      seen.add(tab.cwd);
      const name = tab.cwd.split(/[/\\]/).filter(Boolean).pop() || tab.cwd;
      if (name.toLowerCase().includes(q) || tab.cwd.toLowerCase().includes(q)) {
        out.push({ kind: "file", id: tab.cwd, label: name, detail: tab.cwd });
      }
    }

    // @skill
    for (const s of BUILTIN_SKILLS) {
      if (s.label.includes(q)) out.push(s);
    }

    return out;
  }, [query, worktrees, tabs]);

  useEffect(() => setSelectedIdx(0), [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(items.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (items[selectedIdx]) onSelect(items[selectedIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [items, selectedIdx, onSelect, onClose]);

  // Scroll the selected item into view.
  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (items.length === 0) return null;

  const iconFor = (kind: MentionItem["kind"]) =>
    kind === "file" ? "📄" : kind === "project" ? "📁" : "✨";

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Mention suggestions"
      className="absolute left-4 right-4 z-40 max-h-64 overflow-y-auto rounded-lg border border-gb-border/10 bg-gb-surface-solid shadow-xl"
      style={{ bottom: anchorBottom }}
    >
      {items.map((item, idx) => (
        <button
          key={`${item.kind}:${item.id}`}
          role="option"
          aria-selected={idx === selectedIdx}
          onClick={() => onSelect(item)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
            idx === selectedIdx ? "bg-gb-accent/15 text-gb-text" : "text-gb-text hover:bg-gb-surface-hover"
          }`}
        >
          <span className="shrink-0">{iconFor(item.kind)}</span>
          <span className="font-medium">{item.label}</span>
          <span className="ml-1 rounded bg-gb-bg px-1 text-[9px] uppercase text-gb-muted">
            {item.kind}
          </span>
          {item.detail && (
            <span className="ml-auto truncate text-[10px] text-gb-muted">{item.detail}</span>
          )}
        </button>
      ))}
    </div>
  );
}
