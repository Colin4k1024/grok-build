import { useSessionStore } from "../stores/sessionStore";
import { PageShell, PageSectionTitle } from "../components/layout/PageShell";
import { Card, EmptyState } from "../components/ui";

interface Props {
  onOpenSession: (sessionId: string) => void;
}

/**
 * Dashboard (R4-09 #242): focuses on what needs the user's attention and
 * recent activity — no vanity metrics. Sessions that need action (pending
 * approval/question, failed subagents, streaming) surface first and are
 * directly openable; recent subagent activity links back to its session.
 *
 * The decorative stats bar (活跃会话/流式输出中/Token/上下文容量) was
 * removed: those were non-actionable counts. Empty states point to the next
 * step instead of a bare blank page.
 */
export function Dashboard({ onOpenSession }: Props) {
  const tabs = useSessionStore((s) => s.tabs);
  const messages = useSessionStore((s) => s.messages);
  const subagents = useSessionStore((s) => s.subagents);
  // Per-session streaming map — the global `isStreaming` would flag every
  // idle session as streaming whenever any one session runs.
  const streamingMap = useSessionStore((s) => s.streaming);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions);
  const pendingQuestions = useSessionStore((s) => s.pendingQuestions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const allSubagents = Object.entries(subagents)
    .flatMap(([sid, agents]) => agents.map((a) => ({ ...a, sessionId: sid })))
    .sort((a, b) => b.createdAt - a.createdAt);

  // Sessions that need the user's attention right now.
  const needsAttention = tabs.filter((t) => {
    const hasPendingApproval =
      (pendingPermissions[t.id]?.length ?? 0) > 0 ||
      (pendingQuestions[t.id]?.length ?? 0) > 0;
    const hasFailedAgent = (subagents[t.id] ?? []).some((a) => a.status === "failed");
    const isStreaming = streamingMap[t.id] === true && t.id !== activeSessionId;
    return hasPendingApproval || hasFailedAgent || isStreaming;
  });

  function open(sessionId: string) {
    setActiveSession(sessionId);
    onOpenSession(sessionId);
  }

  return (
    <PageShell>
      {/* Needs attention — actionable first */}
      <section className="mb-6">
        <PageSectionTitle>需要处理</PageSectionTitle>
        {needsAttention.length === 0 ? (
          <EmptyState
            title="无需处理的项"
            description="没有等待批准、失败代理或进行中的会话需要关注。"
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {needsAttention.map((t) => {
              const pendingCount =
                (pendingPermissions[t.id]?.length ?? 0) + (pendingQuestions[t.id]?.length ?? 0);
              const failedAgents = (subagents[t.id] ?? []).filter((a) => a.status === "failed").length;
              const isStreaming = streamingMap[t.id] === true && t.id !== activeSessionId;
              return (
                <Card key={t.id} interactive className="p-0">
                  <button type="button" onClick={() => open(t.id)} className="block w-full p-3 text-left">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-gb-sm font-medium">{t.title || "Untitled"}</span>
                      {t.id === activeSessionId && (
                        <span className="rounded bg-gb-accent/20 px-1.5 py-0.5 text-[10px] text-gb-accent-text">活跃</span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-gb-xs text-gb-text-muted">{t.cwd}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                      {pendingCount > 0 && (
                        <span className="rounded bg-gb-warning/15 px-1.5 py-0.5 text-gb-warning-text">{pendingCount} 待处理</span>
                      )}
                      {failedAgents > 0 && (
                        <span className="rounded bg-gb-danger/10 px-1.5 py-0.5 text-gb-danger-text">{failedAgents} 失败代理</span>
                      )}
                      {isStreaming && (
                        <span className="rounded bg-gb-info/10 px-1.5 py-0.5 text-gb-info-text">生成中</span>
                      )}
                    </div>
                  </button>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* All sessions */}
      <section className="mb-6">
        <PageSectionTitle>会话</PageSectionTitle>
        {tabs.length === 0 ? (
          <EmptyState
            title="没有活跃会话"
            description="在会话页新建或恢复一个会话以开始工作。"
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {tabs.map((t) => {
              const msgCount = (messages[t.id] || []).length;
              const isActive = t.id === activeSessionId;
              const runningAgents = (subagents[t.id] ?? []).filter((a) => a.status === "running").length;
              return (
                <Card key={t.id} interactive className={`p-0 ${isActive ? "border-gb-accent bg-gb-accent/5" : ""}`}>
                  <button type="button" onClick={() => open(t.id)} className="block w-full p-3 text-left">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-gb-sm font-medium">{t.title || "Untitled"}</span>
                      {isActive && (
                        <span className="rounded bg-gb-accent/20 px-1.5 py-0.5 text-[10px] text-gb-accent-text">活跃</span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-gb-xs text-gb-text-muted">{t.cwd}</p>
                    <div className="mt-2 flex items-center gap-3 text-[10px] text-gb-text-muted">
                      {t.model && <span>{t.model}</span>}
                      <span>{msgCount} 条消息</span>
                      {runningAgents > 0 && (
                        <span className="text-gb-info-text">{runningAgents} 个代理运行中</span>
                      )}
                    </div>
                  </button>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Recent activity — links back to sessions */}
      <section>
        <PageSectionTitle>最近活动</PageSectionTitle>
        {allSubagents.length === 0 ? (
          <EmptyState title="暂无子代理活动" description="子代理开始工作后会在此显示。" />
        ) : (
          <Card>
            <ul className="divide-y gb-border-hairline">
              {allSubagents.slice(0, 30).map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => open(a.sessionId)}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-gb-surface-hover"
                  >
                    <span
                      className={
                        a.status === "running"
                          ? "text-gb-info-text"
                          : a.status === "done"
                            ? "text-gb-success-text"
                            : a.status === "failed"
                              ? "text-gb-danger-text"
                              : "text-gb-text-muted"
                      }
                      aria-hidden="true"
                    >
                      ●
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-gb-sm font-medium">{a.name}</div>
                      {a.summary && <p className="truncate text-gb-xs text-gb-text-muted">{a.summary}</p>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </PageShell>
  );
}
