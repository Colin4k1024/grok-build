import { useEffect } from "react";
import { onAcpEvent, respondPermission, sendMessage, type AcpEventPayload } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";
import type { ConnectionStatus } from "../stores/sessionStore";

const SUBAGENT_TOOLS = ["task", "subagent", "spawn", "delegate", "fork"];

function isSubagentTool(name: string): boolean {
  const lower = name.toLowerCase();
  return SUBAGENT_TOOLS.some((t) => lower.includes(t));
}

function updateStatus(sid: string, status: ConnectionStatus, error?: string | null) {
  const current = useSessionStore.getState().connectionStatus[sid];
  const prio: Record<ConnectionStatus, number> = { error: 4, disconnected: 3, reconnecting: 2, connected: 1 };
  if (prio[status] >= (prio[current] ?? 0)) {
    useSessionStore.getState().setConnectionStatus(sid, status, status === "connected" ? null : error);
  }
}

export function useAcpEventListener() {
  const appendAssistantText = useSessionStore((s) => s.appendAssistantText);
  const addToolCall = useSessionStore((s) => s.addToolCall);
  const addToolResult = useSessionStore((s) => s.addToolResult);
  const setStreaming = useSessionStore((s) => s.setStreaming);
  const addPendingPermission = useSessionStore((s) => s.addPendingPermission);
  const addSubagent = useSessionStore((s) => s.addSubagent);
  const updateSubagent = useSessionStore((s) => s.updateSubagent);
  const setTodos = useSessionStore((s) => s.setTodos);
  const setTokenUsage = useSessionStore((s) => s.setTokenUsage);
  const setCompacting = useSessionStore((s) => s.setCompacting);
  const addCompactionMarker = useSessionStore((s) => s.addCompactionMarker);
  const addUserMessage = useSessionStore((s) => s.addUserMessage);
  const setSessionStreaming = useSessionStore((s) => s.setSessionStreaming);

  useEffect(() => {
    const unlisten = onAcpEvent((event: AcpEventPayload) => {
      const sid = event.session_id;
      if (!sid) return;
      const isTab = useSessionStore.getState().tabs.some((t) => t.id === sid);
      if (!isTab) return;
      const replay = event.replay === true;

      if (event.type !== "Error" && event.type !== "Close") {
        updateStatus(sid, "connected");
      }

      switch (event.type) {
        case "TextDelta":
          if (event.delta) { appendAssistantText(sid, event.delta); if (!replay) { setStreaming(true); setSessionStreaming(sid, true); } }
          break;
        case "UserMessage":
          if (replay && event.text) addUserMessage(sid, event.text);
          break;
        case "ToolCall":
          if (event.tool_name) {
            addToolCall(sid, event.tool_name);
            if (isSubagentTool(event.tool_name)) {
              const subId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              addSubagent(sid, { id: subId, name: event.tool_name, status: "running", summary: "", toolCallId: subId, createdAt: Date.now() });
            }
          }
          break;
        case "ToolResult":
          addToolResult(sid, event.tool_name || "", event.output || "", event.success ?? false);
          if (event.tool_name && isSubagentTool(event.tool_name)) {
            const state = useSessionStore.getState(); const agents = state.subagents[sid] || [];
            const agent = agents.filter((a) => a.name === event.tool_name && a.status === "running").pop();
            if (agent) updateSubagent(sid, agent.id, { status: event.success ? "done" : "failed", summary: event.output ? event.output.slice(0, 500) : "" });
          }
          break;
        case "TurnComplete":
          setStreaming(false); setSessionStreaming(sid, false);
          { const state = useSessionStore.getState(); if (state.compacting[sid]) { setCompacting(sid, false); addCompactionMarker(sid, { timestamp: Date.now(), tokensBefore: state.tokenUsage[sid]?.used ?? null, tokensAfter: null, summary: null }); } }
          { const next = useSessionStore.getState().shiftQueuedPrompt(sid); if (next) { useSessionStore.getState().addUserMessage(sid, next); setStreaming(true); setSessionStreaming(sid, true); sendMessage(sid, next).catch(() => setStreaming(false)); } }
          break;
        case "Error":
          setStreaming(false); setSessionStreaming(sid, false);
          if (event.message?.includes("Agent process exited")) updateStatus(sid, "disconnected", event.message);
          else if (event.message?.includes("connection") || event.message?.includes("ECONNREFUSED")) updateStatus(sid, "disconnected", event.message);
          else updateStatus(sid, "error", event.message ?? null);
          break;
        case "Close": setStreaming(false); setSessionStreaming(sid, false); updateStatus(sid, "disconnected", "Session closed"); break;
        case "RateLimit": useSessionStore.getState().setRateLimit(sid, { until: Date.now() + Math.max(1, event.retry_after_seconds ?? 60) * 1000, message: event.message ?? "rate limited" }); setStreaming(false); setSessionStreaming(sid, false); break;
        case "PlanUpdate": if (event.entries) setTodos(sid, event.entries.map((e, i) => ({ id: `todo-${i}`, content: e.content, status: e.status as "Pending" | "InProgress" | "Completed", priority: e.priority }))); break;
        case "UsageUpdate": if (event.used !== undefined && event.size !== undefined) setTokenUsage(sid, event.used, event.size); break;
        case "CompactionStatus":
          if (event.compaction_status) {
            if (event.compaction_status === "started") setCompacting(sid, true);
            else if (event.compaction_status === "completed") { setCompacting(sid, false); addCompactionMarker(sid, { timestamp: Date.now(), tokensBefore: event.compaction_tokens_before ?? null, tokensAfter: event.compaction_tokens_after ?? null, summary: event.compaction_summary ?? null }); }
            else if (event.compaction_status === "failed" || event.compaction_status === "cancelled") setCompacting(sid, false);
          }
          break;
        case "UserQuestionRequest": if (event.request_id) useSessionStore.getState().addPendingQuestion(sid, { requestId: event.request_id, questions: event.questions ?? [], mode: event.mode ?? "default" }); break;
        case "PermissionRequest":
          if (event.request_id) {
            const mode = useSessionStore.getState().tabs.find((t) => t.id === sid)?.approvalMode ?? "ask";
            const options = event.options ?? []; const kind = (o: { kind: string }) => o.kind.toLowerCase();
            if (mode === "full-access") { const allow = options.find((o) => kind(o).startsWith("allow")); if (allow) { respondPermission(sid, event.request_id, allow.id, false).catch(console.error); break; } }
            else if (mode === "read-only") { const deny = options.find((o) => kind(o).startsWith("reject") || kind(o).includes("cancel")); if (deny) { respondPermission(sid, event.request_id, deny.id, false).catch(console.error); break; } }
            addPendingPermission(sid, { requestId: event.request_id, toolName: event.tool_name || "Unknown", command: event.command || "", options });
          }
          break;
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [appendAssistantText, addToolCall, addToolResult, setStreaming, addPendingPermission, addSubagent, updateSubagent, setTodos, setTokenUsage, setCompacting, addCompactionMarker, addUserMessage, setSessionStreaming]);
}
