// @vitest-environment jsdom
//
// Regression guard for the streaming render path: a text delta flush must
// only re-render the message list — the shell (sidebar / titlebar) must not
// re-render. The original whole-store destructure in App re-rendered the
// entire tree at up to 20 Hz while streaming, which was the visible jank.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { useSessionStore } from "../stores/sessionStore";
import type { SessionTab } from "../stores/sessionStore";

const shell = vi.hoisted(() => ({ renders: 0 }));

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();
  return {
    ...actual,
    invoke: vi.fn(async () => undefined),
    getAuthStatus: vi.fn(async () => ({ authenticated: true, username: "t" })),
    getConfig: vi.fn(async () => ({
      models: [],
      default_model: "",
      web_search_model: "",
      image_description_model: "",
      session_summary_model: "",
    })),
    listSessions: vi.fn(async () => []),
    onTrayAction: vi.fn(async () => () => {}),
    onConfigChanged: vi.fn(async () => () => {}),
    onAcpEvent: vi.fn(async () => () => {}),
  };
});

vi.mock("../components/layout/Sidebar", () => ({
  Sidebar: () => {
    shell.renders += 1;
    return <div data-testid="sidebar-shell" />;
  },
}));
vi.mock("../components/layout/TitleBar", () => ({
  TitleBar: () => <div data-testid="titlebar-shell" />,
}));
vi.mock("../components/layout/RightPanel", () => ({
  RightPanel: () => <div />,
}));
vi.mock("../components/chat/WorktreeOnboardingBanner", () => ({
  WorktreeOnboardingBanner: () => null,
}));

import App from "../App";
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
  shell.renders = 0;
});

describe("streaming render isolation", () => {
  it("a stream flush does not re-render the App shell", async () => {
    const { unmount } = render(<App />);
    await waitFor(() => expect(screen.getByTestId("sidebar-shell")).toBeTruthy());

    // Seed an open tab with a message, then reset the shell counter so only
    // post-seed updates are counted.
    act(() => {
      useSessionStore.getState().addTab(tab("s-iso"));
      useSessionStore.getState().addUserMessage("s-iso", "seed");
    });
    expect(shell.renders).toBeGreaterThan(0);
    shell.renders = 0;

    // First flush for a fresh session id applies synchronously (no throttle).
    act(() => {
      useSessionStore.getState().appendAssistantText("s-iso", "delta-token");
    });

    // The delta landed in the store…
    const msgs = useSessionStore.getState().messages["s-iso"];
    expect(msgs.some((m) => m.content.includes("delta-token"))).toBe(true);
    // …without re-rendering the shell. (With the old whole-store
    // destructure this count would grow on every flush.)
    expect(shell.renders).toBe(0);

    unmount();
  });

  it("MessageList renders flushed deltas for the active session", async () => {
    act(() => {
      useSessionStore.getState().addTab(tab("s-list"));
      useSessionStore.getState().addUserMessage("s-list", "seed");
    });
    const { unmount } = render(<MessageList />);
    act(() => {
      useSessionStore.getState().appendAssistantText("s-list", "visible-delta");
    });
    expect(await screen.findByText(/visible-delta/)).toBeTruthy();
    unmount();
  });

  it("an empty resuming session shows the restoring state, not 开始对话", () => {
    act(() => {
      useSessionStore.getState().addTab(tab("s-resume"));
    });
    const { unmount } = render(<MessageList resuming />);
    expect(screen.getByText("正在恢复会话…")).toBeTruthy();
    expect(screen.queryByText("开始对话")).toBeNull();
    unmount();
  });
});
