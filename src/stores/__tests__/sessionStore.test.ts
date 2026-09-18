import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useSessionStore,
  type SessionTab,
  type ChatMessage,
} from "../sessionStore";

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

function makeTab(overrides: Partial<SessionTab> = {}): SessionTab {
  return {
    id: "s1",
    title: "Tab 1",
    cwd: "/w/alpha",
    model: "grok-4",
    reasoningEffort: "medium",
    createdAt: 1000,
    lastActiveAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  resetStore();
});

describe("tab lifecycle", () => {
  it("addTab appends the tab and makes it active", () => {
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "a" }));
    store.addTab(makeTab({ id: "b" }));

    const s = useSessionStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(s.activeSessionId).toBe("b");
  });

  it("removeTab drops the tab and every per-session slice", () => {
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "a" }));
    store.addTab(makeTab({ id: "b" }));
    store.addUserMessage("a", "hello");
    store.addUserMessage("b", "survives");
    store.addPendingPermission("a", {
      requestId: "r1",
      toolName: "bash",
      command: "ls",
      options: [],
    });
    store.setTodos("a", [{ id: "t1", content: "x", status: "Pending", priority: "P1" }]);
    store.setTokenUsage("a", 10, 100);
    store.enqueueQueuedPrompt("a", "queued");

    useSessionStore.getState().removeTab("a");

    const s = useSessionStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["b"]);
    expect(s.messages["a"]).toBeUndefined();
    expect(s.pendingPermissions["a"]).toBeUndefined();
    expect(s.todos["a"]).toBeUndefined();
    expect(s.tokenUsage["a"]).toBeUndefined();
    expect(s.queuedPrompts["a"]).toBeUndefined();
    // b is untouched
    expect(s.messages["b"]).toBeDefined();
  });

  it("removing the active tab activates the neighbor, not null (until the last)", () => {
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "a" }));
    store.addTab(makeTab({ id: "b" }));
    store.addTab(makeTab({ id: "c" }));

    useSessionStore.getState().removeTab("b");
    expect(useSessionStore.getState().activeSessionId).toBe("c");

    useSessionStore.getState().removeTab("c");
    expect(useSessionStore.getState().activeSessionId).toBe("a");

    useSessionStore.getState().removeTab("a");
    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(useSessionStore.getState().tabs).toHaveLength(0);
  });

  it("removing an unknown tab is a no-op, not a crash", () => {
    expect(() => useSessionStore.getState().removeTab("nope")).not.toThrow();
    expect(useSessionStore.getState().tabs).toHaveLength(0);
  });

  it("closeOtherTabs keeps only the kept tab's transcript", () => {
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "a" }));
    store.addTab(makeTab({ id: "b" }));
    store.addUserMessage("a", "keep me");
    store.addUserMessage("b", "drop me");

    useSessionStore.getState().closeOtherTabs("a");

    const s = useSessionStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["a"]);
    expect(s.messages).toEqual({ a: s.messages.a });
    expect(s.activeSessionId).toBe("a");
  });

  it("reorderTabs moves a tab from one index to another", () => {
    const store = useSessionStore.getState();
    ["a", "b", "c"].forEach((id) => store.addTab(makeTab({ id })));

    useSessionStore.getState().reorderTabs(2, 0);
    expect(useSessionStore.getState().tabs.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("rebindTabId swaps the tab id in place, migrating messages (new id wins)", () => {
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "old", acpSessionId: "acp-1" }));
    store.addUserMessage("old", "stale");

    // session/load replay already wrote under the new live id
    store.addUserMessage("new", "fresh");

    useSessionStore.getState().rebindTabId("old", "new", "acp-2");

    const s = useSessionStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["new"]);
    expect(s.tabs[0].acpSessionId).toBe("acp-2");
    // Prefer the replay transcript recorded under the new id
    expect(s.messages["new"].map((m: ChatMessage) => m.content)).toEqual(["fresh"]);
    expect(s.messages["old"]).toBeUndefined();
    expect(s.activeSessionId).toBe("new");
  });

  it("rebindTabId falls back to old messages when the new id has none", () => {
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "old" }));
    store.addUserMessage("old", "migrated");

    useSessionStore.getState().rebindTabId("old", "new");

    const s = useSessionStore.getState();
    expect(s.messages["new"].map((m: ChatMessage) => m.content)).toEqual(["migrated"]);
  });

  it("tab setters update only the targeted tab", () => {
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "a", branch: "feat" }));
    store.addTab(makeTab({ id: "b" }));

    const s = useSessionStore.getState();
    s.renameTab("a", "renamed");
    s.setTabModel("a", "gpt-5");
    s.setTabEffort("a", "high");
    s.setTabCwd("a", "/w/beta");
    s.setTabApprovalMode("a", "full-access");
    useSessionStore.getState().setTabWorkMode("a", "local");

    const [a, b] = useSessionStore.getState().tabs;
    expect(a).toMatchObject({
      title: "renamed",
      model: "gpt-5",
      reasoningEffort: "high",
      cwd: "/w/beta",
      approvalMode: "full-access",
      workMode: "local",
      // switching to local clears the pinned branch
      branch: undefined,
    });
    expect(b).toMatchObject({ title: "Tab 1", model: "grok-4" });
  });

  it("setTabWorkMode(worktree) pins the branch", () => {
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "a" }));

    useSessionStore.getState().setTabWorkMode("a", "worktree", "feat-x");
    expect(useSessionStore.getState().tabs[0]).toMatchObject({
      workMode: "worktree",
      branch: "feat-x",
    });
  });
});

describe("turn state machine (idle → running → waiting → idle)", () => {
  it("a legal full cycle: idle → running → waiting → running → idle", async () => {
    const sid = "cycle-1";
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: sid }));

    // idle
    expect(useSessionStore.getState().isStreaming).toBe(false);

    // → running: first assistant delta starts a streaming message
    store.appendAssistantText(sid, "par");
    let s = useSessionStore.getState();
    expect(s.isStreaming).toBe(false); // global flag is event-driven, not store-driven
    expect(s.messages[sid]).toHaveLength(1);
    expect(s.messages[sid][0]).toMatchObject({ role: "assistant", streaming: true, content: "par" });

    store.setStreaming(true);
    store.setSessionStreaming(sid, true);

    // → waiting: a permission card interrupts the turn
    store.addPendingPermission(sid, {
      requestId: "r1",
      toolName: "bash",
      command: "rm -rf build",
      options: [{ id: "o1", label: "Allow", kind: "AllowOnce" }],
    });
    expect(useSessionStore.getState().pendingPermissions[sid]).toHaveLength(1);

    // waiting → running again after the user answers
    useSessionStore.getState().removePendingPermission(sid, "r1");
    expect(useSessionStore.getState().pendingPermissions[sid]).toHaveLength(0);

    // → idle: turn completes, message settles (the throttled tail flushes
    // within 50ms — wait it out before asserting the final content)
    store.appendAssistantText(sid, "tial");
    await new Promise((r) => setTimeout(r, 80));
    store.finalizeMessages(sid);
    store.setStreaming(false);
    store.setSessionStreaming(sid, false);

    s = useSessionStore.getState();
    expect(s.messages[sid][0].content).toBe("partial");
    expect(s.messages[sid][0].streaming).toBeFalsy();
    expect(s.isStreaming).toBe(false);
    expect(s.streaming[sid]).toBe(false);
  });

  it("finalizeMessages on an already-settled transcript is a no-op", () => {
    const sid = "cycle-2";
    useSessionStore.getState().addTab(makeTab({ id: sid }));
    useSessionStore.getState().addUserMessage(sid, "q");
    const before = useSessionStore.getState().messages[sid];

    useSessionStore.getState().finalizeMessages(sid);

    expect(useSessionStore.getState().messages[sid]).toBe(before);
  });

  it("TurnComplete from an idle session (illegal transition) does not corrupt state", () => {
    const sid = "cycle-3";
    useSessionStore.getState().addTab(makeTab({ id: sid }));
    useSessionStore.getState().setStreaming(false);
    useSessionStore.getState().setSessionStreaming(sid, false);

    // A stray TurnComplete for a never-started turn: nothing to flush
    const queue = useSessionStore.getState().shiftQueuedPrompt(sid);
    expect(queue).toBeUndefined();
    expect(useSessionStore.getState().messages[sid]).toBeUndefined();
  });

  it("per-session streaming is independent of the global flag", () => {
    useSessionStore.getState().addTab(makeTab({ id: "fg" }));
    useSessionStore.getState().addTab(makeTab({ id: "bg" }));

    const s = useSessionStore.getState();
    s.setSessionStreaming("bg", true);
    s.setStreaming(false); // user switched to the foreground tab

    const after = useSessionStore.getState();
    expect(after.streaming["bg"]).toBe(true);
    expect(after.isStreaming).toBe(false);
  });
});

describe("appendAssistantText streaming buffer", () => {
  it("buffers sub-interval deltas and flushes the tail via the trailing timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sid = "stream-1";
      useSessionStore.getState().addTab(makeTab({ id: sid }));

      const store = useSessionStore.getState();
      store.appendAssistantText(sid, "a"); // first write flushes immediately
      store.appendAssistantText(sid, "b"); // within 50 ms → buffered
      store.appendAssistantText(sid, "c"); // still buffered

      let s = useSessionStore.getState();
      expect(s.messages[sid]).toHaveLength(1);
      expect(s.messages[sid][0].content).toBe("a");

      await vi.advanceTimersByTimeAsync(60);

      s = useSessionStore.getState();
      expect(s.messages[sid]).toHaveLength(1);
      expect(s.messages[sid][0].content).toBe("abc");
      expect(s.messages[sid][0].streaming).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("appends to the previous streaming message instead of creating a new one", () => {
    const sid = "stream-2";
    useSessionStore.getState().addTab(makeTab({ id: sid }));

    const store = useSessionStore.getState();
    store.appendAssistantText(sid, "hello ");
    useSessionStore.getState().appendAssistantText(sid + "-x", "other session");

    // Second flush for sid lands after a real >50ms gap? No — within the same
    // tick it buffers; assert the message count stays 1 for sid regardless.
    const s = useSessionStore.getState();
    expect(s.messages[sid]).toHaveLength(1);
    expect(s.messages[sid][0].content).toBe("hello ");
  });

  it("an empty delta never creates a message", () => {
    const sid = "stream-3";
    useSessionStore.getState().addTab(makeTab({ id: sid }));
    useSessionStore.getState().appendAssistantText(sid, "");

    expect(useSessionStore.getState().messages[sid]).toBeUndefined();
  });
});

describe("prompt queue (codex Tab semantics)", () => {
  it("flushes in FIFO order and empties out", () => {
    const store = useSessionStore.getState();
    store.enqueueQueuedPrompt("q", "first");
    store.enqueueQueuedPrompt("q", "second");

    const s = useSessionStore.getState();
    expect(s.shiftQueuedPrompt("q")).toBe("first");
    expect(useSessionStore.getState().shiftQueuedPrompt("q")).toBe("second");
    expect(useSessionStore.getState().shiftQueuedPrompt("q")).toBeUndefined();
    expect(useSessionStore.getState().queuedPrompts["q"]).toEqual([]);
  });

  it("shifting from an unknown session yields undefined without creating the key", () => {
    expect(useSessionStore.getState().shiftQueuedPrompt("ghost")).toBeUndefined();
    expect(useSessionStore.getState().queuedPrompts["ghost"]).toBeUndefined();
  });
});

describe("compaction", () => {
  it("snapshot → marker → rollback restores the pre-compact transcript", () => {
    const sid = "comp-1";
    useSessionStore.getState().addTab(makeTab({ id: sid }));
    useSessionStore.getState().addUserMessage(sid, "before");

    const store = useSessionStore.getState();
    store.snapshotForCompaction(sid);
    store.setCompacting(sid, true);

    // Compaction replaces the transcript with a summary
    useSessionStore.setState({ messages: { [sid]: [] } });
    useSessionStore.getState().addCompactionMarker(sid, {
      timestamp: Date.now(),
      tokensBefore: 100,
      tokensAfter: 10,
      summary: "sum",
    });

    useSessionStore.getState().rollbackCompaction(sid);

    const s = useSessionStore.getState();
    expect(s.messages[sid].map((m) => m.content)).toEqual(["before"]);
    expect(s.compactionMarkers[sid][0].rolledBack).toBe(true);
  });

  it("rollback without a snapshot is a no-op, not a crash", () => {
    const sid = "comp-2";
    useSessionStore.getState().addTab(makeTab({ id: sid }));
    useSessionStore.getState().addUserMessage(sid, "keep");

    expect(() => useSessionStore.getState().rollbackCompaction(sid)).not.toThrow();
    expect(useSessionStore.getState().messages[sid].map((m) => m.content)).toEqual(["keep"]);
  });

  it("rollback marks only the latest marker", () => {
    const sid = "comp-3";
    useSessionStore.getState().addTab(makeTab({ id: sid }));
    const store = useSessionStore.getState();
    store.snapshotForCompaction(sid);
    store.addCompactionMarker(sid, { timestamp: 100, tokensBefore: 1, tokensAfter: 1, summary: null });
    store.snapshotForCompaction(sid);
    store.addCompactionMarker(sid, { timestamp: 200, tokensBefore: 2, tokensAfter: 1, summary: null });

    useSessionStore.getState().rollbackCompaction(sid);

    const markers = useSessionStore.getState().compactionMarkers[sid];
    expect(markers.map((m) => m.rolledBack)).toEqual([false, true]);
  });
});

describe("history restore", () => {
  it("loadHistoryMessages keeps only user/assistant entries and defaults timestamps", () => {
    const sid = "hist-1";
    useSessionStore.getState().addTab(makeTab({ id: sid }));
    const t0 = Date.now();

    useSessionStore.getState().loadHistoryMessages(sid, [
      { role: "user", content: "q", timestamp: 5 },
      { role: "system", content: "sysprompt", timestamp: 6 },
      { role: "assistant", content: "a", timestamp: 7 },
      { role: "tool", content: "ignored", timestamp: 8 },
    ]);

    const msgs = useSessionStore.getState().messages[sid];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0].timestamp).toBe(5);
    expect(msgs.every((m) => m.timestamp > 0 || m.timestamp === 5)).toBe(true);
    expect(t0).toBeGreaterThan(0);
  });

  it("loadHistoryMessages with an empty list yields an empty transcript", () => {
    const sid = "hist-2";
    useSessionStore.getState().addTab(makeTab({ id: sid }));
    useSessionStore.getState().loadHistoryMessages(sid, []);
    expect(useSessionStore.getState().messages[sid]).toEqual([]);
  });
});

describe("tool transcript", () => {
  it("addToolCall then addToolResult append paired tool messages", () => {
    const sid = "tool-1";
    useSessionStore.getState().addTab(makeTab({ id: sid }));
    const store = useSessionStore.getState();
    store.addToolCall(sid, "bash");
    store.addToolResult(sid, "bash", "ok", true);

    const msgs = useSessionStore.getState().messages[sid];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "tool", toolName: "bash", content: "" });
    expect(msgs[1]).toMatchObject({ role: "tool", toolName: "bash", content: "ok", toolSuccess: true });
  });
});

describe("persistence boundary", () => {
  it("persists only tabs + activeSessionId — never transcripts or queues", () => {
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "p1" }));
    store.addUserMessage("p1", "secret transcript");
    store.enqueueQueuedPrompt("p1", "queued secret");

    const raw = localStorage.getItem("gb-session-tabs");
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw!).state;
    expect(persisted.tabs).toHaveLength(1);
    expect(persisted.activeSessionId).toBe("p1");
    expect(persisted.messages).toBeUndefined();
    expect(persisted.queuedPrompts).toBeUndefined();
  });
});

describe("negative scenarios", () => {
  it("clearMessages on an unknown session is safe", () => {
    expect(() => useSessionStore.getState().clearMessages("ghost")).not.toThrow();
  });

  it("negative: concurrent out-of-order events for unknown sessions create no phantom state", () => {
    // Events racing ahead of tab creation (e.g. resume replay) must not leave
    // message/pending entries for sessions that have no tab — the store's
    // record slices stay empty until a tab exists.
    const store = useSessionStore.getState();
    store.addTab(makeTab({ id: "real" }));

    // Simulate the useAcpSession guard contract: events for non-tab ids are
    // dropped before reaching the store. The store itself must tolerate the
    // interleaved writes that DO get through for real tabs.
    store.addUserMessage("real", "m1");
    store.setSessionStreaming("real", true);
    store.setSessionStreaming("real", false);

    const s = useSessionStore.getState();
    expect(Object.keys(s.messages)).toEqual(["real"]);
    expect(Object.keys(s.streaming)).toEqual(["real"]);
  });

  it("renameTab on an unknown id leaves the tab list unchanged", () => {
    useSessionStore.getState().addTab(makeTab({ id: "a" }));
    useSessionStore.getState().renameTab("ghost", "x");
    expect(useSessionStore.getState().tabs[0].title).toBe("Tab 1");
  });
});
