import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAcpEventListener } from "../useAcpSession";
import { useSessionStore, type SessionTab } from "../../stores/sessionStore";
import {
  respondPermission,
  sendMessage,
  type AcpEventPayload,
} from "../../lib/tauri";

// Capture the registered ACP handler so tests can emit events directly.
const emitRef = vi.hoisted(() => ({
  current: null as null | ((e: AcpEventPayload) => void),
}));

vi.mock("../../lib/tauri", () => ({
  onAcpEvent: (fn: (e: AcpEventPayload) => void) => {
    emitRef.current = fn;
    return Promise.resolve(() => {});
  },
  respondPermission: vi.fn(() => Promise.resolve()),
  sendMessage: vi.fn(() => Promise.resolve()),
}));

function emit(event: AcpEventPayload) {
  emitRef.current?.(event);
}

function resetStore() {
  useSessionStore.setState({
    tabs: [],
    activeSessionId: null,
    messages: {},
    pendingPermissions: {},
    pendingQuestions: {},
    subagents: {},
    todos: {},
    tokenUsage: {},
    compacting: {},
    compactionMarkers: {},
    preCompactSnapshot: {},
    queuedPrompts: {},
    isStreaming: false,
    streaming: {},
  });
}

let tabSeq = 0;
function installTab(overrides: Partial<SessionTab> = {}) {
  // Unique id per tab: appendAssistantText's module-level 50ms throttle map
  // keys by session id, so reusing an id across tests bleeds buffering state.
  const tab: SessionTab = {
    id: `s${++tabSeq}`,
    title: "t",
    cwd: "/w",
    model: "m",
    reasoningEffort: "medium",
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  };
  useSessionStore.getState().addTab(tab);
  return tab.id;
}

const PERMISSION_OPTIONS = [
  { id: "o-allow-once", label: "Allow", kind: "AllowOnce" },
  { id: "o-allow-always", label: "Always allow", kind: "AllowAlways" },
  { id: "o-deny", label: "Deny", kind: "RejectAll" },
];

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("turn state machine driven by ACP events", () => {
  it("idle → running → idle: TextDelta starts, TurnComplete settles", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "TextDelta", delta: "par" });
    let s = useSessionStore.getState();
    expect(s.isStreaming).toBe(true);
    expect(s.streaming[sid]).toBe(true);
    expect(s.messages[sid]).toHaveLength(1);

    emit({ session_id: sid, type: "TextDelta", delta: "tial" });
    emit({ session_id: sid, type: "TurnComplete" });

    s = useSessionStore.getState();
    expect(s.isStreaming).toBe(false);
    expect(s.streaming[sid]).toBe(false);
  });

  it("running → waiting: a permission request parks the turn", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "TextDelta", delta: "x" });
    emit({
      session_id: sid,
      type: "PermissionRequest",
      request_id: "r1",
      tool_name: "bash",
      command: "rm -rf build",
      options: PERMISSION_OPTIONS,
    });

    const s = useSessionStore.getState();
    expect(s.pendingPermissions[sid]).toHaveLength(1);
    expect(s.pendingPermissions[sid][0]).toMatchObject({
      requestId: "r1",
      toolName: "bash",
      command: "rm -rf build",
    });
  });

  it("Error event forces the running flag back to idle", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "TextDelta", delta: "x" });
    emit({ session_id: sid, type: "Error", message: "agent crashed" });

    const s = useSessionStore.getState();
    expect(s.isStreaming).toBe(false);
    expect(s.streaming[sid]).toBe(false);
  });

  it("replayed TextDelta restores transcript without flipping the running flag", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "TextDelta", delta: "history", replay: true });

    const s = useSessionStore.getState();
    expect(s.isStreaming).toBe(false);
    expect(s.streaming[sid]).toBeUndefined();
  });

  it("replayed UserMessage rebuilds the user side of the transcript", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "UserMessage", text: "old prompt", replay: true });
    // Non-replay user echo must NOT duplicate the message
    emit({ session_id: sid, type: "UserMessage", text: "echo", replay: false });

    const msgs = useSessionStore.getState().messages[sid];
    expect(msgs.map((m) => m.content)).toEqual(["old prompt"]);
  });
});

describe("approval-mode gating of permission requests", () => {
  it("full-access auto-allows without showing a card", async () => {
    const sid = installTab({ approvalMode: "full-access" });
    renderHook(() => useAcpEventListener());

    emit({
      session_id: sid,
      type: "PermissionRequest",
      request_id: "r1",
      tool_name: "bash",
      command: "cargo build",
      options: PERMISSION_OPTIONS,
    });

    await waitFor(() =>
      expect(respondPermission).toHaveBeenCalledWith(
        sid, "r1", "o-allow-once", false
      )
    );
    expect(useSessionStore.getState().pendingPermissions[sid]).toBeUndefined();
  });

  it("read-only auto-denies with a reject/cancel option", async () => {
    const sid = installTab({ approvalMode: "read-only" });
    renderHook(() => useAcpEventListener());

    emit({
      session_id: sid,
      type: "PermissionRequest",
      request_id: "r2",
      tool_name: "bash",
      command: "cargo build",
      options: PERMISSION_OPTIONS,
    });

    await waitFor(() =>
      expect(respondPermission).toHaveBeenCalledWith(sid, "r2", "o-deny", false)
    );
    expect(useSessionStore.getState().pendingPermissions[sid]).toBeUndefined();
  });

  it("ask mode (default) shows the card and does not auto-respond", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({
      session_id: sid,
      type: "PermissionRequest",
      request_id: "r3",
      tool_name: "bash",
      command: "ls",
      options: PERMISSION_OPTIONS,
    });

    expect(respondPermission).not.toHaveBeenCalled();
    expect(useSessionStore.getState().pendingPermissions[sid]).toHaveLength(1);
  });
});

describe("queue flush on TurnComplete (codex Tab semantics)", () => {
  it("fires the next queued prompt and re-enters running state", async () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    useSessionStore.getState().enqueueQueuedPrompt(sid, "follow-up");
    emit({ session_id: sid, type: "TurnComplete" });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(sid, "follow-up"));
    const s = useSessionStore.getState();
    expect(s.isStreaming).toBe(true);
    expect(s.queuedPrompts[sid]).toEqual([]);
    expect(s.messages[sid].some((m) => m.content === "follow-up")).toBe(true);
  });

  it("an empty queue does not send anything", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "TurnComplete" });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().isStreaming).toBe(false);
  });
});

describe("tool + plan + usage events", () => {
  it("ToolCall/ToolResult append paired messages", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "ToolCall", tool_name: "bash" });
    emit({
      session_id: sid,
      type: "ToolResult",
      tool_name: "bash",
      output: "done",
      success: true,
    });

    const msgs = useSessionStore.getState().messages[sid];
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ toolName: "bash", content: "done", toolSuccess: true });
  });

  it("subagent tools are tracked and finalized by their result", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "ToolCall", tool_name: "spawn_researcher" });
    emit({
      session_id: sid,
      type: "ToolResult",
      tool_name: "spawn_researcher",
      output: "summary text",
      success: true,
    });

    const agents = useSessionStore.getState().subagents[sid];
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "spawn_researcher", status: "done" });
  });

  it("PlanUpdate replaces the todo list", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({
      session_id: sid,
      type: "PlanUpdate",
      entries: [
        { content: "step 1", status: "Completed", priority: "high" },
        { content: "step 2", status: "InProgress", priority: "medium" },
      ],
    });

    const todos = useSessionStore.getState().todos[sid];
    expect(todos.map((t) => t.status)).toEqual(["Completed", "InProgress"]);
  });

  it("UsageUpdate records token usage only when both fields arrive", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "UsageUpdate", used: 42 }); // malformed: no size
    expect(useSessionStore.getState().tokenUsage[sid]).toBeUndefined();

    emit({ session_id: sid, type: "UsageUpdate", used: 42, size: 100 });
    expect(useSessionStore.getState().tokenUsage[sid]).toEqual({ used: 42, size: 100 });
  });
});

describe("compaction events", () => {
  it("started/completed transitions and marker recording", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "CompactionStatus", compaction_status: "started" });
    expect(useSessionStore.getState().compacting[sid]).toBe(true);

    emit({
      session_id: sid,
      type: "CompactionStatus",
      compaction_status: "completed",
      compaction_tokens_before: 1000,
      compaction_tokens_after: 100,
      compaction_summary: "kept the plan",
    });

    const s = useSessionStore.getState();
    expect(s.compacting[sid]).toBe(false);
    expect(s.compactionMarkers[sid]).toHaveLength(1);
    expect(s.compactionMarkers[sid][0]).toMatchObject({
      tokensBefore: 1000,
      tokensAfter: 100,
      summary: "kept the plan",
    });
  });

  it("failed/cancelled clears the compacting flag without a marker", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    emit({ session_id: sid, type: "CompactionStatus", compaction_status: "started" });
    emit({ session_id: sid, type: "CompactionStatus", compaction_status: "failed" });

    const s = useSessionStore.getState();
    expect(s.compacting[sid]).toBe(false);
    expect(s.compactionMarkers[sid]).toBeUndefined();
  });
});

describe("malformed / negative events never crash or mutate", () => {
  it("drops events without a session_id", () => {
    renderHook(() => useAcpEventListener());

    expect(() => {
      emit({ type: "TextDelta", delta: "x" } as AcpEventPayload);
      emit({ type: "TurnComplete" } as AcpEventPayload);
      emit({ type: "PermissionRequest", request_id: "r" } as AcpEventPayload);
    }).not.toThrow();

    const s = useSessionStore.getState();
    expect(s.messages).toEqual({});
    expect(s.pendingPermissions).toEqual({});
  });

  it("drops unknown event types", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    expect(() =>
      emit({ session_id: sid, type: "SomeFutureEventType" } as AcpEventPayload)
    ).not.toThrow();

    expect(useSessionStore.getState().messages[sid]).toBeUndefined();
  });

  it("tolerates TextDelta without a delta and ToolResult without a name", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    expect(() => {
      emit({ session_id: sid, type: "TextDelta" });
      emit({ session_id: sid, type: "ToolResult", output: "x", success: true });
      emit({ session_id: sid, type: "ToolCall" });
      emit({ session_id: sid, type: "PermissionRequest" });
      emit({ session_id: sid, type: "UserQuestionRequest" });
      emit({ session_id: sid, type: "CompactionStatus" });
      emit({ session_id: sid, type: "PlanUpdate" });
    }).not.toThrow();

    const s = useSessionStore.getState();
    expect(s.pendingPermissions[sid]).toBeUndefined();
    expect(s.pendingQuestions[sid]).toBeUndefined();
    expect(s.compacting[sid]).toBeUndefined();
  });

  it("concurrent out-of-order events for unknown sessions create no phantom tabs", () => {
    const sid = installTab();
    renderHook(() => useAcpEventListener());

    // Interleave real-tab events with ghost-session events (e.g. a side
    // session or an event racing tab creation).
    emit({ session_id: "ghost-1", type: "TextDelta", delta: "boo" });
    emit({ session_id: sid, type: "TextDelta", delta: "real" });
    emit({ session_id: "ghost-2", type: "PermissionRequest", request_id: "g", options: PERMISSION_OPTIONS });
    emit({ session_id: "ghost-1", type: "UserMessage", text: "boo", replay: true });

    const s = useSessionStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(Object.keys(s.messages)).toEqual([sid]);
    expect(Object.keys(s.pendingPermissions)).toEqual([]);
    expect(respondPermission).not.toHaveBeenCalled();
  });
});
