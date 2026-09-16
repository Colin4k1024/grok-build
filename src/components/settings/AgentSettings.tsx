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
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Default agent mode</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <p className="mb-2 text-xs text-gb-muted">
            Controls whether new sessions start in Chat or Agent mode. You can
            still switch per-message from the composer on the Home page.
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
                {m === "chat" ? "💬 Chat" : "🤖 Agent"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gb-muted">
            Agent mode runs tools autonomously; Chat mode waits for your
            approval before each tool call.
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Autonomous execution</h3>
        <label className="flex cursor-pointer items-center justify-between rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div>
            <p className="text-xs font-medium text-gb-text">Auto-approve safe tools</p>
            <p className="mt-0.5 text-[11px] text-gb-muted">
              Skip the approval prompt for read-only tools (list files, search,
              read). Writes and shell commands still require approval.
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
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                autonomous ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Permissions</h3>
        <p className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3 text-xs text-gb-muted">
          Approval rules, trusted folders, and sandbox mode are managed under
          the <span className="text-gb-text">Permissions</span> and{" "}
          <span className="text-gb-text">Trusted Folders</span> tabs.
        </p>
      </section>
    </div>
  );
}
