import { useState, useEffect, useMemo } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { listHistorySessions, pickDirectory, type HistorySession, type ConfigSnapshot } from "../lib/tauri";
import { PromptInput } from "../components/chat/PromptInput";
import type { ApprovalMode } from "../stores/sessionStore";
import { getSandboxMode } from "../components/layout/SandboxToggle";

export type ComposerMode = "chat" | "agent";

interface HomeProps {
  config: ConfigSnapshot | null;
  onStart: (
    prompt: string,
    images: { data: string; mime_type: string }[],
    prefs: { cwd: string; model: string; effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"; approval: ApprovalMode }
  ) => void;
  onOpenSession: (id: string) => void;
  onResumeThread: (session: HistorySession) => void;
  creating: boolean;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

// Codex New-chat screen: one composer (project / model / approval embedded)
// above the recent-threads list. No mode toggle, no second composer.
export function Home({ config, onStart, onOpenSession, onResumeThread, creating }: HomeProps) {
  const tabs = useSessionStore((s) => s.tabs);

  const [projectCwd, setProjectCwd] = useState(".");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<"none" | "minimal" | "low" | "medium" | "high" | "xhigh">("medium");
  const [approval, setApproval] = useState<ApprovalMode>(
    getSandboxMode() === "sandbox" ? "ask" : "full-access"
  );

  useEffect(() => {
    if (!model && config?.models.length) {
      const def = config.models.find((m) => m.id === config.default_model) ?? config.models[0];
      if (def) setModel(def.id);
    }
  }, [config, model]);

  // Open tabs (live this run)
  const recent = useMemo(
    () => [...tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 6),
    [tabs]
  );

  // Persisted threads from disk — pick up any past conversation.
  const [threads, setThreads] = useState<HistorySession[]>([]);
  useEffect(() => {
    listHistorySessions().then((list) => setThreads(list.slice(0, 6))).catch(() => {});
  }, []);

  const chooseFolder = async () => {
    try {
      const dir = await pickDirectory();
      if (dir) setProjectCwd(dir);
    } catch (e) {
      console.error("[home] pick folder failed:", e);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-3 text-center text-gb-brand" aria-hidden>✻</div>

        {/* Project title — codex scopes the new chat to a project */}
        <div className="mb-4 flex items-center justify-center gap-2">
          <span className="max-w-[300px] truncate text-[13px] font-medium text-gb-text-secondary">
            {projectCwd === "." ? "未选择项目" : projectCwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop()}
          </span>
          <button
            onClick={chooseFolder}
            className="rounded px-1.5 py-0.5 text-[11px] text-gb-muted transition-colors hover:bg-gb-surface-hover hover:text-gb-text"
            title="选择项目目录"
          >
            {projectCwd === "." ? "选择目录…" : "更改"}
          </button>
        </div>

        <PromptInput
          onSend={(message, images) => onStart(message, images, { cwd: projectCwd, model, effort, approval })}
          onCancel={() => {}}
          isStreaming={false}
          disabled={creating}
          config={config}
          home={{
            cwd: projectCwd,
            model,
            effort,
            approval,
            onCwdChange: setProjectCwd,
            onPatch: (patch) => {
              if (patch.model !== undefined) setModel(patch.model);
              if (patch.effort !== undefined) setEffort(patch.effort);
              if (patch.approval !== undefined) setApproval(patch.approval);
            },
          }}
        />

        {/* Open tabs (live this run) */}
        {recent.length > 0 && (
          <div className="mt-10">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gb-muted">
              Open sessions
            </h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recent.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => onOpenSession(tab.id)}
                  className="group flex flex-col rounded-lg border border-gb-border/10 bg-gb-surface-solid/50 p-3 text-left transition-colors hover:border-gb-border/20 hover:bg-gb-surface-solid"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-gb-text group-hover:text-gb-accent">
                      {tab.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-gb-muted">
                      {formatRelativeTime(tab.lastActiveAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-gb-muted">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="shrink-0 opacity-60">
                      <path d="M0 1.5C0 .7.7 0 1.5 0h3l1.5 1.5h2.5C9.3 1.5 10 2.2 10 3v5.5c0 .8-.7 1.5-1.5 1.5h-7C.7 10 0 9.3 0 8.5v-7z" />
                    </svg>
                    <span className="truncate">{tab.cwd || "."}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Persisted threads — resumable across restarts */}
        {threads.length > 0 && (
          <div className={recent.length > 0 ? "mt-6" : "mt-10"}>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gb-muted">
              Recent threads
            </h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {threads.map((thread) => (
                <button
                  key={thread.id}
                  onClick={() => onResumeThread(thread)}
                  className="group flex flex-col rounded-lg border border-gb-border/10 bg-gb-surface-solid/50 p-3 text-left transition-colors hover:border-gb-accent/30 hover:bg-gb-surface-solid"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-gb-text group-hover:text-gb-accent">
                      {thread.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-gb-muted">
                      {formatRelativeTime(thread.updated_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-gb-muted">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" className="shrink-0 opacity-60">
                      <path d="M1.5 5s1.5-2.8 3.5-2.8S8.5 5 8.5 5 7 7.8 5 7.8 1.5 5 1.5 5z" />
                      <circle cx="5" cy="5" r="1.2" />
                    </svg>
                    <span className="truncate">{thread.cwd || "."}</span>
                    <span className="shrink-0 opacity-60">·</span>
                    <span className="shrink-0">{thread.num_messages} 条消息</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
