import { useSessionStore } from "../stores/sessionStore";

interface Props {
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

export function Dashboard({ onClose, onOpenSession }: Props) {
  const tabs = useSessionStore((s) => s.tabs);
  const messages = useSessionStore((s) => s.messages);
  const subagents = useSessionStore((s) => s.subagents);
  const tokenUsage = useSessionStore((s) => s.tokenUsage);
  const streaming = useSessionStore((s) => s.isStreaming);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const activeSessions = tabs.length;
  const streamingSessions = tabs.filter((t) => streaming && t.id !== activeSessionId).length;
  const totalTokensUsed = Object.values(tokenUsage).reduce((sum, u) => sum + u.used, 0);
  const totalTokensSize = Object.values(tokenUsage).reduce((sum, u) => sum + u.size, 0);

  // Collect all subagent activity across sessions
  const allSubagents = Object.entries(subagents)
    .flatMap(([sid, agents]) =>
      agents.map((a) => ({ ...a, sessionId: sid }))
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  function handleCardClick(sessionId: string) {
    setActiveSession(sessionId);
    onOpenSession(sessionId);
  }

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-gb-border bg-gb-surface px-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">仪表盘</h2>
          <span className="text-[10px] text-gb-muted">全局概览</span>
        </div>
        <button
          className="rounded px-2 py-1 text-xs text-gb-muted hover:bg-gb-bg hover:text-gb-text"
          onClick={onClose}
        >
          ← 返回对话
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Stats bar */}
        <div className="mb-4 grid grid-cols-4 gap-3">
          <StatCard label="活跃会话" value={String(activeSessions)} />
          <StatCard label="流式输出中" value={String(streamingSessions)} accent={streamingSessions > 0 ? "blue" : undefined} />
          <StatCard label="Token 总量" value={formatTokens(totalTokensUsed)} />
          <StatCard
            label="上下文容量"
            value={totalTokensSize > 0 ? `${Math.round((totalTokensUsed / totalTokensSize) * 100)}%` : "—"}
          />
        </div>

        <div className="flex gap-4">
          {/* Session cards */}
          <div className="flex-1">
            <h3 className="mb-2 text-xs font-semibold text-gb-muted">会话</h3>
            {tabs.length === 0 ? (
              <p className="py-8 text-center text-xs text-gb-muted">暂无活跃会话</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {tabs.map((tab) => {
                  const msgCount = (messages[tab.id] || []).length;
                  const usage = tokenUsage[tab.id];
                  const isActive = tab.id === activeSessionId;
                  const agents = subagents[tab.id] || [];
                  const runningAgents = agents.filter((a) => a.status === "running").length;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => handleCardClick(tab.id)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        isActive
                          ? "border-gb-accent bg-gb-accent/10"
                          : "border-gb-border bg-gb-surface hover:border-gb-muted"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate text-xs font-medium">{tab.title || "Untitled"}</span>
                        {isActive && (
                          <span className="rounded bg-gb-accent/20 px-1.5 py-0.5 text-[9px] text-gb-accent">活跃</span>
                        )}
                      </div>
                      <div className="mt-1 truncate text-[10px] text-gb-muted">{tab.cwd}</div>
                      <div className="mt-2 flex items-center gap-3 text-[10px] text-gb-muted">
                        {tab.model && <span>🤖 {tab.model}</span>}
                        <span>💬 {msgCount} msgs</span>
                        {runningAgents > 0 && (
                          <span className="text-gb-blue">⚡ {runningAgents} agents</span>
                        )}
                        {usage && (
                          <span className="tabular-nums">
                            {formatTokens(usage.used)}/{formatTokens(usage.size)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Subagent activity stream */}
          <div className="w-72 shrink-0">
            <h3 className="mb-2 text-xs font-semibold text-gb-muted">子代理动态</h3>
            <div className="h-96 overflow-y-auto rounded-lg border border-gb-border bg-gb-surface p-2">
              {allSubagents.length === 0 ? (
                <p className="py-8 text-center text-[10px] text-gb-muted">暂无子代理动态</p>
              ) : (
                <div className="space-y-1">
                  {allSubagents.slice(0, 50).map((agent) => (
                    <div key={agent.id} className="flex items-start gap-2 rounded px-2 py-1 text-[10px] hover:bg-gb-bg">
                      <span className={
                        agent.status === "running" ? "text-gb-blue" :
                        agent.status === "done" ? "text-gb-green" :
                        agent.status === "failed" ? "text-gb-red" :
                        "text-gb-muted"
                      }>
                        {agent.status === "running" ? "●" : agent.status === "done" ? "✓" : agent.status === "failed" ? "✗" : "○"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="truncate font-medium">{agent.name}</span>
                        </div>
                        {agent.summary && (
                          <p className="truncate text-gb-muted">{agent.summary}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: "blue" }) {
  return (
    <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
      <p className="text-[10px] uppercase text-gb-muted">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${accent === "blue" ? "text-gb-blue" : "text-gb-text"}`}>
        {value}
      </p>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}
