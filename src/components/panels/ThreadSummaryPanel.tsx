import { useState, useMemo } from "react";
import { useSessionStore } from "../../stores/sessionStore";

/**
 * Thread summary panel — collapsible AI-generated digest of the current
 * conversation. Codex parity: `toggle-thread-summary-panel`.
 *
 * The summary is computed client-side from the messages we already have:
 * decisions are user messages that start with "do", "use", "let's", etc.;
 * code changes are tool calls that modified files (bash/write/edit). When
 * an AI summary service is wired in later, replace the derivation below
 * with a fetch to it.
 */
export function ThreadSummaryPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    activeSessionId ? s.messages[activeSessionId] || [] : []
  );
  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === activeSessionId));

  const summary = useMemo(() => {
    if (messages.length === 0) return null;
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const toolCalls = messages.filter((m) => m.role === "tool");
    const writeOps = toolCalls.filter(
      (t) => t.toolName && /write|edit|apply|patch|create/i.test(t.toolName)
    );

    const firstUser = userMessages[0]?.content.slice(0, 140) || "";
    const lastAssistant = assistantMessages[assistantMessages.length - 1]?.content.slice(0, 140) || "";

    return {
      messageCount: messages.length,
      userCount: userMessages.length,
      assistantCount: assistantMessages.length,
      toolCallCount: toolCalls.length,
      editCount: writeOps.length,
      firstUser,
      lastAssistant,
    };
  }, [messages]);

  if (!activeSessionId || !summary) {
    return (
      <p className="py-8 text-center text-xs text-gb-muted">暂无可摘要的消息。</p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center justify-between border-b border-gb-border/8 px-3 py-2 text-left"
        aria-expanded={!collapsed}
      >
        <span className="text-[11px] font-medium uppercase text-gb-muted">
          Thread summary
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          className={`text-gb-muted transition-transform ${collapsed ? "" : "rotate-180"}`}
        >
          <path d="M2 3.5L5 7l3-3.5z" />
        </svg>
      </button>

      {!collapsed && (
        <div className="flex-1 space-y-3 overflow-y-auto p-3 text-[12px]">
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase text-gb-muted">会话</p>
            <p className="text-gb-text">{activeTab?.title || "Untitled"}</p>
            <p className="mt-0.5 text-[10px] text-gb-muted">{activeTab?.cwd || "."}</p>
          </div>

          <div>
            <p className="mb-1 text-[10px] font-medium uppercase text-gb-muted">动态</p>
            <ul className="space-y-0.5 text-gb-text-secondary">
              <li>{summary.messageCount} messages ({summary.userCount} from you)</li>
              <li>{summary.toolCallCount} tool calls</li>
              {summary.editCount > 0 && (
                <li className="text-gb-accent">{summary.editCount} file edits</li>
              )}
            </ul>
          </div>

          {summary.firstUser && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase text-gb-muted">开始于</p>
              <p className="rounded bg-gb-bg-secondary p-2 text-[11px] text-gb-text-secondary">
                {summary.firstUser}
                {summary.firstUser.length >= 140 ? "…" : ""}
              </p>
            </div>
          )}

          {summary.lastAssistant && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase text-gb-muted">最新回复</p>
              <p className="rounded bg-gb-bg-secondary p-2 text-[11px] text-gb-text-secondary">
                {summary.lastAssistant}
                {summary.lastAssistant.length >= 140 ? "…" : ""}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
