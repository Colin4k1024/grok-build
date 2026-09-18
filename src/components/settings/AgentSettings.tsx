import { useState, useEffect } from "react";

const AGENT_MODE_KEY = "gb-agent-default-mode";
const AGENT_AUTONOMOUS_KEY = "gb-agent-autonomous";

export type AgentMode = "chat" | "agent";

function isValidMode(v: string | null): v is AgentMode {
  return v === "chat" || v === "agent";
}

export function getDefaultAgentMode(): AgentMode {
  const raw = localStorage.getItem(AGENT_MODE_KEY);
  return isValidMode(raw) ? raw : "chat";
}

export function setDefaultAgentMode(mode: AgentMode) {
  localStorage.setItem(AGENT_MODE_KEY, mode);
}

export function getAutonomousEnabled(): boolean {
  return localStorage.getItem(AGENT_AUTONOMOUS_KEY) === "true";
}

export function setAutonomousEnabled(v: boolean) {
  localStorage.setItem(AGENT_AUTONOMOUS_KEY, String(v));
}

export function AgentSettings() {
  // Lazy initializers so we don't read localStorage on every render.
  const [mode, setMode] = useState<AgentMode>(() => getDefaultAgentMode());
  const [autonomous, setAutonomous] = useState(() => getAutonomousEnabled());

  useEffect(() => {
    setDefaultAgentMode(mode);
  }, [mode]);

  useEffect(() => {
    setAutonomousEnabled(autonomous);
  }, [autonomous]);

  return (
    <div className="space-y-6 p-4">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">默认 Agent 模式</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <p className="mb-2 text-xs text-gb-muted">
            控制新会话以「对话」还是「Agent」模式启动。你仍然可以在
            首页输入框中按消息切换。
          </p>
          <div className="flex gap-2">
            {(["chat", "agent"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === m
                    ? "bg-gb-accent/15 text-gb-text"
                    : "bg-gb-bg text-gb-muted hover:text-gb-text"
                }`}
              >
                {m === "chat" ? "💬 对话" : "🤖 Agent"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gb-muted">
            Agent 模式自动执行工具；对话模式在每次工具调用前
            等待你的批准。
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">自动执行</h3>
        <label className="flex cursor-pointer items-center justify-between rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div>
            <p className="text-xs font-medium text-gb-text">自动批准安全工具</p>
            <p className="mt-0.5 text-[11px] text-gb-muted">
              对只读工具（列目录、搜索、读取）跳过审批提示。
              写入和 shell 命令仍需批准。
            </p>
          </div>
          <button
            role="switch"
            aria-checked={autonomous}
            onClick={() => setAutonomous(!autonomous)}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              autonomous ? "bg-gb-accent" : "bg-gb-border"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-gb-bg transition-transform ${
                autonomous ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">权限</h3>
        <p className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3 text-xs text-gb-muted">
          审批规则、受信任目录和沙箱模式在
          <span className="text-gb-text">「权限」</span>和{" "}
          <span className="text-gb-text">「受信任目录」</span>标签页中管理。
        </p>
      </section>
    </div>
  );
}
