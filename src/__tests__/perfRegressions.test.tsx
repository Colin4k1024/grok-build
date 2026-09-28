// @vitest-environment jsdom
//
// Regression guards for the interaction-latency fixes. Each test pins a
// specific hot-path behaviour that was measured as a stall:
//
//   1. store setters must not create a new state object when nothing changed
//      (every new object re-runs every selector in the app, ~50-100×/s during
//      a streaming turn)
//   2. MessageList must not re-render for another session's traffic
//   3. in-thread search must still complete while a reply is streaming
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { useSessionStore } from "../stores/sessionStore";
import type { SessionTab } from "../stores/sessionStore";

const counts = vi.hoisted(() => ({ messageItem: 0, rail: 0 }));

vi.mock("../components/chat/MessageItem", () => ({
  MessageItem: ({ message }: { message: { id: string; content: string } }) => {
    counts.messageItem += 1;
    return <div data-testid={`msg-${message.id}`}>{message.content}</div>;
  },
}));
vi.mock("../components/chat/CompactionMarker", () => ({
  CompactionMarkerItem: () => <div data-testid="marker" />,
}));
vi.mock("../components/chat/ThreadSearchRail", () => ({
  ThreadSearchRail: () => {
    counts.rail += 1;
    return <div data-testid="rail" />;
  },
}));

import { MessageList } from "../components/chat/MessageList";

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
    rateLimits: {},
    compacting: {},
    compactionMarkers: {},
    preCompactSnapshot: {},
    queuedPrompts: {},
    isStreaming: false,
    streaming: {},
  });
}

const tab = (id: string): SessionTab => ({
  id,
  acpSessionId: id,
  title: `Tab ${id}`,
  cwd: "/w",
  model: "m",
  reasoningEffort: "medium",
  createdAt: 1,
  lastActiveAt: 1,
});

beforeEach(() => {
  resetStore();
  counts.messageItem = 0;
  counts.rail = 0;
});

describe("store setter idempotency (no state churn on the streaming path)", () => {
  it("setSessionStreaming with the same value keeps state identity", () => {
    const s = useSessionStore.getState();
    s.setSessionStreaming("a", true);
    const after = useSessionStore.getState();

    // Fires on every TextDelta. A new object here re-ran every selector in the
    // app and re-rendered the whole thread tree at token rate.
    s.setSessionStreaming("a", true);
    expect(useSessionStore.getState()).toBe(after);
  });

  it("setStreaming with the same value keeps state identity", () => {
    useSessionStore.getState().setStreaming(true);
    const after = useSessionStore.getState();
    useSessionStore.getState().setStreaming(true);
    expect(useSessionStore.getState()).toBe(after);
  });

  it("setTokenUsage with the same value keeps state identity", () => {
    useSessionStore.getState().setTokenUsage("a", 10, 100);
    const after = useSessionStore.getState();
    useSessionStore.getState().setTokenUsage("a", 10, 100);
    expect(useSessionStore.getState()).toBe(after);
  });

  it("setCompacting with the same value keeps state identity", () => {
    useSessionStore.getState().setCompacting("a", true);
    const after = useSessionStore.getState();
    useSessionStore.getState().setCompacting("a", true);
    expect(useSessionStore.getState()).toBe(after);
  });

  it("setActiveSession with the same id keeps state identity", () => {
    useSessionStore.getState().setActiveSession("a");
    const after = useSessionStore.getState();
    useSessionStore.getState().setActiveSession("a");
    expect(useSessionStore.getState()).toBe(after);
  });

  it("renameTab / setTabModel with unchanged values keep tabs identity", () => {
    useSessionStore.getState().addTab(tab("a"));
    const after = useSessionStore.getState().tabs;
    useSessionStore.getState().renameTab("a", "Tab a");
    useSessionStore.getState().setTabModel("a", "m");
    expect(useSessionStore.getState().tabs).toBe(after);
  });

  it("still records a real streaming transition", () => {
    const before = useSessionStore.getState();
    before.setSessionStreaming("a", true);
    expect(useSessionStore.getState()).not.toBe(before);
    expect(useSessionStore.getState().streaming.a).toBe(true);
  });
});

describe("MessageList render isolation", () => {
  it("does not re-render for another session's stream", async () => {
    act(() => {
      const s = useSessionStore.getState();
      s.addTab(tab("shown"));
      s.addTab(tab("background"));
      s.setActiveSession("shown");
      s.addUserMessage("shown", "hello");
    });

    const { unmount } = render(<MessageList />);
    await waitFor(() => expect(screen.getByTestId("rail")).toBeTruthy());
    const baseline = counts.messageItem;
    expect(baseline).toBeGreaterThan(0);

    // 20 flushes of traffic on a DIFFERENT session. The old markers selector
    // returned a fresh `[]` on every store change, so all of these re-rendered
    // the visible list.
    act(() => {
      for (let i = 0; i < 20; i++) {
        useSessionStore.getState().appendAssistantText("background", `tok${i} `);
        useSessionStore.getState().setSessionStreaming("background", true);
      }
    });

    expect(counts.messageItem).toBe(baseline);
    unmount();
  });

  it("re-renders only the changed message for its own stream", async () => {
    act(() => {
      const s = useSessionStore.getState();
      s.addTab(tab("live"));
      s.setActiveSession("live");
      s.addUserMessage("live", "q1");
      s.addUserMessage("live", "q2");
      s.addUserMessage("live", "q3");
    });

    const { unmount } = render(<MessageList />);
    await waitFor(() => expect(screen.getByTestId("rail")).toBeTruthy());
    counts.messageItem = 0;

    // The first flush for a session applies synchronously (no throttle) and
    // appends one new assistant message.
    act(() => {
      useSessionStore.getState().appendAssistantText("live", "answer");
    });

    // 3 existing rows + 1 new assistant row — not a full re-render storm, and
    // never more than the item count.
    expect(counts.messageItem).toBeLessThanOrEqual(4);
    expect(screen.getByText("answer")).toBeTruthy();
    unmount();
  });
});

describe("in-thread search", () => {
  it("returns results while a reply is still streaming", async () => {
    // Real component — this file mocks ThreadSearchRail for the MessageList
    // counts above, so bypass the registry.
    const { ThreadSearchRail } = await vi.importActual<
      typeof import("../components/chat/ThreadSearchRail")
    >("../components/chat/ThreadSearchRail");

    act(() => {
      const s = useSessionStore.getState();
      s.addTab(tab("searchable"));
      s.setActiveSession("searchable");
      s.addUserMessage("searchable", "find the needle here");
    });

    const { unmount } = render(<ThreadSearchRail />);

    act(() => {
      fireEvent.click(screen.getByLabelText("搜索当前会话"));
    });
    act(() => {
      fireEvent.change(screen.getByPlaceholderText("搜索会话内容…"), {
        target: { value: "needle" },
      });
    });

    // Keep the stream flowing for longer than the 150 ms debounce. The old
    // effect depended on the messages array, so every flush cleared and
    // restarted the timer and results never arrived mid-turn.
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      act(() => {
        useSessionStore.getState().appendAssistantText("searchable", "noise ");
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    // Asserted immediately, with the stream still hot: no idle window for a
    // perpetually-deferred debounce to sneak in.
    expect(screen.getByText(/needle/)).toBeTruthy();
    unmount();
  });
});
