import { useMemo, useState } from "react";
import { useSessionStore, type Subagent } from "../stores/sessionStore";
import { PageShell, PageSectionTitle } from "../components/layout/PageShell";
import { Card, EmptyState, Button } from "../components/ui";

interface WorkspaceAgentsPageProps {
  onOpenSession: (id: string) => void;
}

/**
 * Workspace-wide agent overview (R4-09 #242): master-detail, unified with the
 * other pages via PageShell + EmptyState (list and detail) + Card panels.
 * Failed agents surface a recovery action (open the owning session) instead
 * of a pure display card; detail panels share the Card primitive.
 */
export function WorkspaceAgentsPage({ onOpenSession }: WorkspaceAgentsPageProps) {
  const tabs = useSessionStore((s) => s.tabs);
  const subagents = useSessionStore((s) => s.subagents);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const all = useMemo(() => {
    const list: { agent: Subagent; sessionId: string; sessionTitle: string }[] = [];
    for (const tab of tabs) {
      const items = subagents[tab.id] || [];
      for (const a of items) {
        list.push({ agent: a, sessionId: tab.id, sessionTitle: tab.title });
      }
    }
    return list.sort((a, b) => b.agent.createdAt - a.agent.createdAt);
  }, [tabs, subagents]);

  const selected = all.find((x) => `${x.sessionId}:${x.agent.id}` === selectedAgentId);

  const statusDot =
    "inline-block h-1.5 w-1.5 shrink-0 rounded-full";

  return (
    <PageShell contentClassName="flex overflow-hidden p-0">
      {/* List */}
      <div className="w-80 shrink-0 overflow-y-auto border-r gb-border-hairline bg-gb-sidebar p-2">
        <PageSectionTitle>子代理</PageSectionTitle>
        {all.length === 0 ? (
          <EmptyState title="暂无子代理" description="会话生成子代理后会在此显示。" />
        ) : (
          all.map(({ agent, sessionId, sessionTitle }) => {
            const key = `${sessionId}:${agent.id}`;
            const active = key === selectedAgentId;
            return (
              <button
                key={key}
                onClick={() => setSelectedAgentId(key)}
                aria-current={active ? "true" : undefined}
                className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-gb-md px-2.5 py-2 text-left transition-colors duration-gb-fast ease-gb ${
                  active ? "bg-gb-surface-hover" : "hover:bg-gb-surface-hover"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`${statusDot} ${
                      agent.status === "running"
                        ? "bg-gb-accent"
                        : agent.status === "done"
                          ? "bg-gb-success-text"
                          : agent.status === "failed"
                            ? "bg-gb-danger-text"
                            : "bg-gb-text-muted"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="truncate text-gb-sm font-medium text-gb-text-primary">{agent.name}</span>
                </div>
                <span className="truncate text-[10px] text-gb-text-muted">
                  {sessionTitle} · {agent.status}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Detail */}
      <div className="flex-1 overflow-y-auto p-6">
        {!selected ? (
          <EmptyState title="选择一个代理" description="在左侧选择代理以查看其详情与可执行操作。" />
        ) : (
          <div className="mx-auto max-w-2xl space-y-4">
            <div>
              <h3 className="text-gb-md font-semibold text-gb-text-primary">{selected.agent.name}</h3>
              <p className="mt-0.5 text-gb-xs text-gb-text-muted">
                会话：{" "}
                <button
                  type="button"
                  onClick={() => onOpenSession(selected.sessionId)}
                  className="text-gb-accent-text hover:underline"
                >
                  {selected.sessionTitle}
                </button>
              </p>
            </div>

            {selected.agent.status === "failed" && (
              <Card className="border-gb-danger/40 bg-gb-danger/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-gb-xs font-medium uppercase text-gb-danger-text">失败</p>
                    <p className="mt-1 text-gb-sm text-gb-text-secondary">
                      {selected.agent.summary || "代理执行失败。"}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => onOpenSession(selected.sessionId)}>
                    打开会话恢复
                  </Button>
                </div>
              </Card>
            )}

            <Card className="p-4">
              <p className="mb-1 text-gb-xs font-medium uppercase text-gb-text-muted">状态</p>
              <p className="text-gb-sm text-gb-text-primary">{selected.agent.status}</p>
            </Card>

            <Card className="p-4">
              <p className="mb-1 text-gb-xs font-medium uppercase text-gb-text-muted">摘要</p>
              <pre className="whitespace-pre-wrap text-gb-sm text-gb-text-secondary">
                {selected.agent.summary || "暂无摘要。"}
              </pre>
            </Card>

            <Card className="p-4">
              <p className="mb-1 text-gb-xs font-medium uppercase text-gb-text-muted">元数据</p>
              <dl className="grid grid-cols-2 gap-2 text-gb-sm">
                <dt className="text-gb-text-muted">ID</dt>
                <dd className="truncate font-mono text-gb-text-primary">{selected.agent.id}</dd>
                <dt className="text-gb-text-muted">工具调用</dt>
                <dd className="truncate font-mono text-gb-text-primary">{selected.agent.toolCallId}</dd>
                <dt className="text-gb-text-muted">创建于</dt>
                <dd className="text-gb-text-primary">
                  {new Date(selected.agent.createdAt).toLocaleString()}
                </dd>
              </dl>
            </Card>
          </div>
        )}
      </div>
    </PageShell>
  );
}
