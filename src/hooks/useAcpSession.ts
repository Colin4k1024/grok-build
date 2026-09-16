import { useEffect } from "react";
import { onAcpEvent, type AcpEventPayload } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";

export function useAcpEventListener() {
  const appendAssistantText = useSessionStore((s) => s.appendAssistantText);
  const addToolCall = useSessionStore((s) => s.addToolCall);
  const addToolResult = useSessionStore((s) => s.addToolResult);
  const setStreaming = useSessionStore((s) => s.setStreaming);

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
          }
          break;
        case "ToolResult":
          addToolResult(sid, event.tool_name || "", event.output || "", event.success ?? false);
          break;
        case "TurnComplete":
          setStreaming(false);
          break;
        case "Error":
          setStreaming(false);
          break;
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [appendAssistantText, addToolCall, addToolResult, setStreaming]);
}
