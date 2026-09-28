import { useState, useEffect } from "react";
import { PromptInput } from "../components/chat/PromptInput";
import { WorkOverview } from "../components/home/WorkOverview";
import type { ApprovalMode } from "../stores/sessionStore";
import { getSandboxMode } from "../components/layout/SandboxToggle";
import { pickDirectory, type ConfigSnapshot, type HistorySession } from "../lib/tauri";

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

// Codex New-chat screen: one composer (project / model / approval embedded)
// above a single merged work overview. No mode toggle, no second composer.
export function Home({ config, onStart, onOpenSession, onResumeThread, creating }: HomeProps) {

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
        <div className="mb-3 flex justify-center text-gb-accent-text" aria-hidden>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
          </svg>
        </div>

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
          disabledReason="正在创建会话…"
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

        {/* R4-04: one merged work overview — live sessions and resumable
            history never duplicate, and empty state is actionable. */}
        <WorkOverview onOpenSession={onOpenSession} onResumeThread={onResumeThread} />
      </div>
    </div>
  );
}
