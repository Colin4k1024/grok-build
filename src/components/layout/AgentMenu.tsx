import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "../../stores/sessionStore";

/**
 * Agent menu in the TitleBar — lets the user inspect the current session's
 * agent state and flip agent-related toggles. Codex exposes a similar
 * "agent-menu" in the top bar.
 */
export function AgentMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tabs = useSessionStore((s) => s.tabs);
  const subagents = useSessionStore((s) =>
    activeSessionId ? s.subagents[activeSessionId] || [] : []
  );
  const activeTab = tabs.find((t) => t.id === activeSessionId);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!activeSessionId) return null;

  const running = subagents.filter((s) => s.status === "running").length;
  const total = subagents.length;

  return (
    <div ref={ref} className="relative" data-no-drag>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-gb-text-secondary hover:bg-gb-surface-hover hover:text-gb-text"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Agent 设置"
      >
        <span className="text-[11px]">🤖</span>
        <span>Agent</span>
        {running > 0 && (
          <span className="ml-0.5 flex h-1.5 w-1.5 animate-pulse rounded-full bg-gb-accent" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-gb-border/10 bg-gb-surface-solid py-1 shadow-lg">
          <div className="border-b border-gb-border/8 px-3 py-2">
            <p className="text-[10px] font-medium uppercase text-gb-muted">Agent 状态</p>
            <p className="mt-0.5 text-[12px] text-gb-text">
              {activeTab?.title || "当前会话"}
            </p>
            <p className="text-[10px] text-gb-muted">
              {running} 个运行中 · 共 {total} 个子代理
            </p>
          </div>

          <div className="px-3 py-2">
            <p className="mb-1 text-[10px] font-medium uppercase text-gb-muted">
              推理强度
            </p>
            <p className="text-[11px] text-gb-text-secondary">
              当前：<span className="text-gb-text">{activeTab?.reasoningEffort || "medium"}</span>
            </p>
            <p className="mt-1 text-[10px] text-gb-muted">
              通过标题栏的下拉菜单调整推理强度。
            </p>
          </div>

          <div className="border-t border-gb-border/8 px-3 py-2">
            <p className="mb-1 text-[10px] font-medium uppercase text-gb-muted">
              权限
            </p>
            <p className="text-[10px] text-gb-muted">
              审批规则在「设置 → 权限」中管理。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
