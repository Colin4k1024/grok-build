import { useEffect } from "react";
import { onAcpEvent, type AcpEventPayload } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";

// Tool names that indicate subagent operations
const SUBAGENT_TOOLS = ["task", "subagent", "spawn", "delegate", "fork"];

function isSubagentTool(name: string): boolean {
  const lower = name.toLowerCase();
  return SUBAGENT_TOOLS.some((t) => lower.includes(t));
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

  useEffect(() => {
    const unlisten = onAcpEvent((event: AcpEventPayload) => {
      const sid = event.session_id;
      if (!sid) return;
      const replay = event.replay === true;

      switch (event.type) {
        case "TextDelta":
          if (event.delta) {
            appendAssistantText(sid, event.delta);
            // Replay chunks are historical transcript restore, not a live
            // streaming turn — never flip the streaming indicator for them.
            if (!replay) setStreaming(true);
          }
          break;
        case "UserMessage":
          // Replayed user echo from session/load — rebuilds the user side of
          // the restored transcript.
          if (replay && event.text) addUserMessage(sid, event.text);
          break;
        case "ToolCall":
          if (event.tool_name) {
            addToolCall(sid, event.tool_name);
            // Track subagent spawn
            if (isSubagentTool(event.tool_name)) {
              const subId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              addSubagent(sid, {
                id: subId,
                name: event.tool_name,
                status: "running",
                summary: "",
                toolCallId: subId,
                createdAt: Date.now(),
              });
            }
          }
          break;
        case "ToolResult":
          addToolResult(sid, event.tool_name || "", event.output || "", event.success ?? false);
          // Update subagent status based on result
          if (event.tool_name && isSubagentTool(event.tool_name)) {
            const state = useSessionStore.getState();
            const agents = state.subagents[sid] || [];
            const agent = agents
              .filter((a) => a.name === event.tool_name && a.status === "running")
              .pop();
            if (agent) {
              updateSubagent(sid, agent.id, {
                status: event.success ? "done" : "failed",
                summary: event.output ? event.output.slice(0, 500) : "",
              });
            }
          }
          break;
        case "TurnComplete":
          setStreaming(false);
          // If a manual compaction was in progress, mark it complete
          {
            const compacting = useSessionStore.getState().compacting[sid];
            if (compacting) {
              const usage = useSessionStore.getState().tokenUsage[sid];
              setCompacting(sid, false);
              addCompactionMarker(sid, {
                timestamp: Date.now(),
                tokensBefore: usage ? usage.used : null,
                tokensAfter: null,
                summary: null,
              });
            }
          }
          break;
        case "Error":
          setStreaming(false);
          break;
        case "PlanUpdate":
          if (event.entries) {
            setTodos(sid, event.entries.map((e, i) => ({
              id: `todo-${i}`,
              content: e.content,
              status: e.status as "Pending" | "InProgress" | "Completed",
              priority: e.priority,
            })));
          }
          break;
        case "UsageUpdate":
          if (event.used !== undefined && event.size !== undefined) {
            setTokenUsage(sid, event.used, event.size);
          }
          break;
        case "CompactionStatus":
          if (event.compaction_status) {
            if (event.compaction_status === "started") {
              setCompacting(sid, true);
            } else if (event.compaction_status === "completed") {
              setCompacting(sid, false);
              addCompactionMarker(sid, {
                timestamp: Date.now(),
                tokensBefore: event.compaction_tokens_before ?? null,
                tokensAfter: event.compaction_tokens_after ?? null,
                summary: event.compaction_summary ?? null,
              });
            } else if (event.compaction_status === "failed" || event.compaction_status === "cancelled") {
              setCompacting(sid, false);
            }
          }
          break;
        case "PermissionRequest":
          if (event.request_id) {
            addPendingPermission(sid, {
              requestId: event.request_id,
              toolName: event.tool_name || "Unknown",
              command: event.command || "",
              options: event.options || [],
            });
          }
          break;
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [
    appendAssistantText, addToolCall, addToolResult, setStreaming,
    addPendingPermission, addSubagent, updateSubagent, setTodos, setTokenUsage,
    setCompacting, addCompactionMarker, addUserMessage,
  ]);
}
