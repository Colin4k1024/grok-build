import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSessionStore, type SessionTab, type ChatMessage } from "../../stores/sessionStore";
import { openHistoryThread } from "../threadResume";
import {
  resumeSession,
  closeSession,
  getSessionHistoryMessages,
  type HistorySession,
  type SessionInfo,
} from "../../lib/tauri";

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    resumeSession: vi.fn(),
    closeSession: vi.fn(),
    getSessionHistoryMessages: vi.fn(),
  };
});

const resumeMock = vi.mocked(resumeSession);
const closeMock = vi.mocked(closeSession);
const diskMock = vi.mocked(getSessionHistoryMessages);

/** Full reset — zustand merges partials, so spell out every slice. */
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

let seq = 0;
function hist(overrides: Partial<HistorySession> = {}): HistorySession {
  seq += 1;
  return {
    id: `acp-${seq}`,
    session_id: `acp-${seq}`,
    title: "A thread title",
    cwd: "/w/demo",
    updated_at: Date.now() - 60_000,
    last_active_at: new Date(Date.now() - 60_000).toISOString(),
    model: "",
    num_messages: 3,
    ...overrides,
  };
}

function info(acpId: string, modelId = "grok-code"): SessionInfo {
  return { id: `live-${acpId}`, cwd: "/w/demo", acp_session_id: acpId, models: [{ id: modelId, name: modelId }] };
}

function diskMessages(): { role: string; content: string; timestamp: number }[] {
  return [
    { role: "user", content: "from disk", timestamp: 1 },
    { role: "assistant", content: "disk answer", timestamp: 2 },
  ];
}

function msgs(sessionId: string): ChatMessage[] {
  return useSessionStore.getState().messages[sessionId] ?? [];
}

beforeEach(() => {
  resetStore();
  resumeMock.mockReset();
  closeMock.mockReset();
  diskMock.mockReset();
  // Safe defaults — individual tests override.
  resumeMock.mockResolvedValue({ id: "live-default", cwd: "/w/demo", acp_session_id: "acp-default", models: [] });
  closeMock.mockResolvedValue(undefined);
  diskMock.mockResolvedValue([]);
});

describe("openHistoryThread", () => {
  it("opens an optimistic tab synchronously, before the agent spawn resolves", async () => {
    let resolveResume!: (v: SessionInfo) => void;
    resumeMock.mockReturnValue(new Promise<SessionInfo>((r) => { resolveResume = r; }));
    const session = hist();

    let settled = false;
    const promise = openHistoryThread(session, {
      onOptimisticOpen: vi.fn(),
      onFocusExisting: vi.fn(),
      onStreamingExisting: vi.fn(),
      onError: vi.fn(),
    }).finally(() => { settled = true; });

    // Same-tick assertions: the click itself switches the view.
    const st = useSessionStore.getState();
    expect(st.tabs).toHaveLength(1);
    expect(st.tabs[0].id).toBe(`pending:${session.id}`);
    expect(st.tabs[0].acpSessionId).toBe(session.id);
    expect(st.activeSessionId).toBe(`pending:${session.id}`);
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    resolveResume(info(session.id));
    await promise;
    expect(settled).toBe(true);
  });

  it("double-fire before resolve spawns the agent once", async () => {
    let resolveResume!: (v: SessionInfo) => void;
    resumeMock.mockReturnValue(new Promise<SessionInfo>((r) => { resolveResume = r; }));
    const session = hist();

    const p1 = openHistoryThread(session, { onOptimisticOpen: vi.fn(), onFocusExisting: vi.fn(), onStreamingExisting: vi.fn(), onError: vi.fn() });
    const p2 = openHistoryThread(session, { onOptimisticOpen: vi.fn(), onFocusExisting: vi.fn(), onStreamingExisting: vi.fn(), onError: vi.fn() });

    // The second click saw the optimistic tab and just focused it.
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().tabs).toHaveLength(1);

    resolveResume(info(session.id));
    await Promise.all([p1, p2]);
    expect(useSessionStore.getState().tabs).toHaveLength(1);
  });

  it("rebinds to the live id and fills from disk when replay produced nothing", async () => {
    const session = hist({ model: "" });
    const live = info(session.id, "grok-code-fast");
    resumeMock.mockResolvedValue(live);
    diskMock.mockResolvedValue(diskMessages());

    await openHistoryThread(session, { onOptimisticOpen: vi.fn(), onFocusExisting: vi.fn(), onStreamingExisting: vi.fn(), onError: vi.fn() });

    const st = useSessionStore.getState();
    expect(st.tabs).toHaveLength(1);
    expect(st.tabs[0].id).toBe(live.id);
    expect(st.tabs[0].acpSessionId).toBe(live.acp_session_id);
    expect(st.activeSessionId).toBe(live.id);
    // No model on the history entry → adopt the agent's default.
    expect(st.tabs[0].model).toBe("grok-code-fast");
    expect(diskMock).toHaveBeenCalledWith(session.id, session.cwd);
    expect(msgs(live.id).map((m) => m.content)).toContain("from disk");
  });

  it("keeps the live replay and never merges the disk copy on top of it", async () => {
    const session = hist({ model: "keep-me" });
    const live = info(session.id);
    resumeMock.mockImplementation(async () => {
      // Replay events land under the live id before the rebind runs —
      // rebindTabId must prefer them over the optimistic tab's slice.
      useSessionStore.getState().addUserMessage(live.id, "replayed user turn");
      return live;
    });
    diskMock.mockResolvedValue([{ role: "assistant", content: "disk must not appear", timestamp: 9 }]);

    await openHistoryThread(session, { onOptimisticOpen: vi.fn(), onFocusExisting: vi.fn(), onStreamingExisting: vi.fn(), onError: vi.fn() });

    const contents = msgs(live.id).map((m) => m.content);
    expect(contents).toContain("replayed user turn");
    expect(contents).not.toContain("disk must not appear");
    expect(useSessionStore.getState().tabs[0].model).toBe("keep-me");
  });

  it("rolls the optimistic tab back on failure so a retry can spawn again", async () => {
    resumeMock.mockRejectedValue(new Error("spawn failed"));
    const session = hist();
    const onError = vi.fn();

    await openHistoryThread(session, { onOptimisticOpen: vi.fn(), onFocusExisting: vi.fn(), onStreamingExisting: vi.fn(), onError });

    expect(useSessionStore.getState().tabs).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("spawn failed"));

    // Retry path is not shadowed by a dead tab.
    resumeMock.mockResolvedValue(info(session.id));
    diskMock.mockResolvedValue([]);
    await openHistoryThread(session, { onOptimisticOpen: vi.fn(), onFocusExisting: vi.fn(), onStreamingExisting: vi.fn(), onError: vi.fn() });
    expect(resumeMock).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().tabs).toHaveLength(1);
  });

  it("closing the optimistic tab mid-spawn closes the live session instead of orphaning it", async () => {
    let resolveResume!: (v: SessionInfo) => void;
    resumeMock.mockReturnValue(new Promise<SessionInfo>((r) => { resolveResume = r; }));
    const session = hist();
    const optimisticId = `pending:${session.id}`;

    const promise = openHistoryThread(session, { onOptimisticOpen: vi.fn(), onFocusExisting: vi.fn(), onStreamingExisting: vi.fn(), onError: vi.fn() });
    // User closes the pending tab while the agent is still spawning.
    useSessionStore.getState().removeTab(optimisticId);
    expect(useSessionStore.getState().tabs).toHaveLength(0);

    const live = info(session.id);
    resolveResume(live);
    await promise;

    // The freshly spawned backend session is torn down, nothing rebinds.
    expect(closeMock).toHaveBeenCalledWith(live.id);
    expect(useSessionStore.getState().tabs).toHaveLength(0);
    expect(useSessionStore.getState().messages[live.id]).toBeUndefined();
  });

  it("paints the disk transcript into the pending tab before the spawn resolves", async () => {
    let resolveResume!: (v: SessionInfo) => void;
    resumeMock.mockReturnValue(new Promise<SessionInfo>((r) => { resolveResume = r; }));
    const session = hist();
    diskMock.mockResolvedValue(diskMessages());
    const optimisticId = `pending:${session.id}`;

    void openHistoryThread(session, { onOptimisticOpen: vi.fn(), onFocusExisting: vi.fn(), onStreamingExisting: vi.fn(), onError: vi.fn() });

    // The local disk read settles in microtasks — the agent spawn does not.
    await vi.waitFor(() => {
      expect(msgs(optimisticId).map((m) => m.content)).toContain("from disk");
    });
    expect(resumeMock).toHaveBeenCalledTimes(1);

    const live = info(session.id);
    resolveResume(live);
    await vi.waitFor(() => {
      expect(useSessionStore.getState().tabs[0]?.id).toBe(live.id);
    });
    // The pre-painted transcript migrated to the live id — not duplicated.
    expect(msgs(live.id).map((m) => m.content)).toContain("from disk");
    expect(msgs(live.id)).toHaveLength(2);
  });

  it("focuses an already-open live tab without spawning", async () => {
    const session = hist();
    const open: SessionTab = {
      id: "tab-1",
      acpSessionId: session.id,
      title: "Open",
      cwd: session.cwd,
      model: "m",
      reasoningEffort: "medium",
      createdAt: 1,
      lastActiveAt: 1,
    };
    useSessionStore.setState({ tabs: [open], activeSessionId: null });
    const onFocusExisting = vi.fn();

    await openHistoryThread(session, { onOptimisticOpen: vi.fn(), onFocusExisting, onStreamingExisting: vi.fn(), onError: vi.fn() });

    expect(resumeMock).not.toHaveBeenCalled();
    expect(useSessionStore.getState().activeSessionId).toBe("tab-1");
    expect(onFocusExisting).toHaveBeenCalledTimes(1);
  });
});
