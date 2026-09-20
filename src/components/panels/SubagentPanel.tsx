import { useState, useMemo, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useSessionStore, type Subagent } from "../../stores/sessionStore";

/**
 * Subagent panel — shows every spawned subagent as a collapsible card:
 *
 *   1. Header row: status dot + name + status label + [Cancel].
 *   2. Progress (when running): step-by-step items from progressItems.
 *   3. Final result (when done/failed): rendered with ReactMarkdown
 *      (remark-gfm + rehype-highlight), same as the main message list.
 *
 * Design rules (from /goal):
 *   - 思考过程只在 streaming 时展示，完成后不保留。
 *   - 工具执行默认折叠，只显示成功/失败。
 *   - 结果必须用 markdown 渲染。
 */

// ---- Sub-status for each step in a subagent's work ----
interface StepItem {
  label: string;
  status: "todo" | "in_progress" | "done" | "failed";
}

export function SubagentPanel() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const subagents = useSessionStore((s) => s.subagents);
  const updateSubagent = useSessionStore((s) => s.updateSubagent);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sessionSubagents: Subagent[] = useMemo(
    () => (activeSessionId ? subagents[activeSessionId] || [] : []),
    [activeSessionId, subagents]
  );

  // Compute active-running count for the summary badge.
  const runningCount = useMemo(
    () => sessionSubagents.filter((s) => s.status === "running" || s.status === "spawning").length,
    [sessionSubagents]
  );

  const handleCancel = useCallback(
    (id: string) => {
      updateSubagent(activeSessionId!, id, { status: "failed" });
    },
    [activeSessionId, updateSubagent]
  );

  // ---- Status helpers ----
  const statusColors: Record<Subagent["status"], string> = {
    spawning: "bg-gb-yellow",
    running: "bg-gb-accent",
    done: "bg-gb-green",
    failed: "bg-gb-red",
    cancelled: "bg-gb-muted",
  };

  const statusLabels: Record<Subagent["status"], string> = {
    spawning: "Spawning",
    running: "运行中",
    done: "完成",
    failed: "失败",
    cancelled: "已取消",
  };

  // ---- Step status helpers ----
  const stepDot = (status: StepItem["status"]) => {
    switch (status) {
      case "done":
        return <span className="text-gb-green">✓</span>;
      case "failed":
        return <span className="text-gb-red">✗</span>;
      case "in_progress":
        return <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-gb-accent" />;
      case "todo":
      default:
        return <span className="inline-block h-1.5 w-1.5 rounded-full bg-gb-border" />;
    }
  };

  if (sessionSubagents.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-gb-muted">
        无活跃子代理。
      </div>
    );
  }

  return (
    <div className="space-y-1.5 p-2">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase text-gb-muted">
          Subagents ({sessionSubagents.length})
        </span>
        {runningCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-gb-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gb-accent" />
            {runningCount} running
          </span>
        )}
      </div>

      {/* Agent cards */}
      {sessionSubagents.map((agent) => {
        const isExpanded = expandedId === agent.id;
        const isActive = agent.status === "running" || agent.status === "spawning";
        const hasProgress = (agent.progressItems?.length ?? 0) > 0;
        const hasResult = agent.summary && (agent.status === "done" || agent.status === "failed");

        return (
          <div
            key={agent.id}
            className={`rounded-md border bg-gb-surface transition-colors ${
              agent.status === "failed"
                ? "border-gb-red/30"
                : agent.status === "done"
                  ? "border-gb-green/20"
                  : "border-gb-border"
            }`}
          >
            {/* Header row — always visible */}
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left"
              onClick={() => setExpandedId(isExpanded ? null : agent.id)}
            >
              {/* Collapse toggle */}
              {hasResult ? (
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  fill="currentColor"
                  className={`shrink-0 text-gb-muted transition-transform ${
                    isExpanded ? "" : "-rotate-90"
                  }`}
                >
                  <path d="M1 2l3 3 3-3z" />
                </svg>
              ) : (
                <span className="w-2 shrink-0" />
              )}

              {/* Status dot */}
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  isActive ? "animate-pulse " : ""
                }${statusColors[agent.status]}`}
              />

              {/* Name + status */}
              <div className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-gb-text">
                  {agent.name}
                </span>
                <span className="text-[10px] text-gb-muted">
                  {statusLabels[agent.status]}
                </span>
              </div>

              {/* Cancel button — only when active */}
              {isActive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCancel(agent.id);
                  }}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[9px] text-gb-red hover:bg-gb-red/10"
                  aria-label="取消子代理"
                >
                  取消
                </button>
              )}
            </button>

            {/* Expanded body */}
            {isExpanded && (
              <div className="border-t border-gb-border/8">
                {/* Step-by-step progress (only when active or has progress items) */}
                {hasProgress && (
                  <div className="border-b border-gb-border/8 px-3 py-2">
                    <p className="mb-1.5 text-[9px] font-medium uppercase text-gb-muted">
                      {isActive ? "进行中" : "执行步骤"}
                    </p>
                    <div className="space-y-1">
                      {(agent.progressItems ?? []).map((item, i) => (
                        <div key={i} className="flex items-start gap-2 text-[11px]">
                          <span className="mt-0.5 shrink-0">{stepDot(item.status)}</span>
                          <span
                            className={
                              item.status === "in_progress"
                                ? "text-gb-text"
                                : item.status === "done"
                                  ? "text-gb-text-secondary"
                                  : "text-gb-muted"
                            }
                          >
                            {item.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Final result — markdown rendered (only when done/failed) */}
                {hasResult && (
                  <div className="px-3 py-2">
                    <p className="mb-1 text-[9px] font-medium uppercase text-gb-muted">
                      {agent.status === "done" ? "结果" : "错误信息"}
                    </p>
                    <div className="prose prose-xs max-w-none text-[11px] leading-relaxed text-gb-text">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight]}
                      >
                        {agent.summary!}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}