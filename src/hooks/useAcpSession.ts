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

  useEffect(() => {
    const unlisten = onAcpEvent((event: AcpEventPayload) => {
      const sid = event.session_id;
      if (!sid) return;

      switch (event.type) {
        case "TextDelta":
          if (event.delta) {
            appendAssistantText(sid, event.delta);
            setStreaming(true);
          }
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
          break;
        case "Error":
          setStreaming(false);
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
    addPendingPermission, addSubagent, updateSubagent,
  ]);
}
