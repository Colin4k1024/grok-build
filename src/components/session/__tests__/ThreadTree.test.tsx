import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadTree } from "../ThreadTree";
import { useSessionStore, type SessionTab } from "../../../stores/sessionStore";
import {
  listHistorySessions,
  type HistorySession,
  type ProjectEntry,
} from "../../../lib/tauri";

const mockHistory = vi.hoisted(() => ({ value: [] as HistorySession[] }));
const mockProjects = vi.hoisted(() => ({ value: [] as ProjectEntry[] }));

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/tauri")>();
  return {
    ...actual,
    listProjects: vi.fn(async () => mockProjects.value),
    listHistorySessions: vi.fn(async () => mockHistory.value),
    removeProject: vi.fn(async () => []),
    deleteHistorySession: vi.fn(async () => undefined),
  };
});

vi.mock("../../../lib/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/desktop")>();
  return {
    ...actual,
    writeText: vi.fn(async () => undefined),
  };
});

const HISTORY: HistorySession[] = [
  {
    id: "acp-1",
    session_id: "acp-1",
    title: "Old thread",
    cwd: "/w/alpha",
    updated_at: Date.now() - 3_600_000,
    last_active_at: new Date(Date.now() - 3_600_000).toISOString(),
    model: "grok-4",
    num_messages: 4,
  },
  {
    id: "hist-loose",
    session_id: "hist-loose",
    title: "No-cwd thread",
    cwd: "",
    updated_at: Date.now() - 7_200_000,
    last_active_at: new Date(Date.now() - 7_200_000).toISOString(),
    model: "grok-4",
    num_messages: 2,
  },
];

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

function installTab(overrides: Partial<SessionTab> = {}) {
  const tab: SessionTab = {
    id: "tab-live",
    title: "Live thread",
    cwd: "/w/alpha",
    model: "grok-4",
    reasoningEffort: "medium",
    createdAt: 1,
    lastActiveAt: Date.now() - 1000,
    ...overrides,
  };
  useSessionStore.getState().addTab(tab);
  return tab;
}

function setup() {
  const props = {
    onNewSessionInDir: vi.fn(),
    onResumeThread: vi.fn(),
    onForkSession: vi.fn(),
    onRenameHistory: vi.fn(),
    onCloseSession: vi.fn(),
  };
  const view = render(<ThreadTree {...props} />);
  return { props, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  mockHistory.value = [];
  mockProjects.value = [];
});

describe("thread grouping", () => {
  it("groups threads by workspace under 项目, loose cwds under 会话", async () => {
    mockHistory.value = HISTORY;
    installTab();
    setup();

    expect(await screen.findByText("Live thread")).toBeInTheDocument();
    expect(screen.getByText("Old thread")).toBeInTheDocument();
    // alpha project group holds both the live tab and its persisted sibling
    expect(screen.getByText("alpha")).toBeInTheDocument();
    // Empty-cwd history thread lands in the loose 会话 section
    expect(screen.getByText("No-cwd thread")).toBeInTheDocument();
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("会话")).toBeInTheDocument();
  });

  it("a live tab suppresses the duplicate persisted entry with the same acp id", async () => {
    mockHistory.value = HISTORY;
    installTab({ acpSessionId: "acp-1", title: "Live thread" });
    setup();

    await screen.findByText("Live thread");
    // The stale "Old thread" entry for the same session is deduped away
    expect(screen.queryByText("Old thread")).toBeNull();
  });

  it("history threads with zero messages are hidden", async () => {
    mockHistory.value = [
      { ...HISTORY[0], id: "empty", session_id: "empty", num_messages: 0 },
    ];
    setup();

    await waitFor(() => expect(listHistorySessions).toHaveBeenCalled());
    expect(screen.queryByText("Old thread")).toBeNull();
  });

  it("bookmarked projects with no threads still appear so a thread can start there", async () => {
    mockProjects.value = [{ path: "/w/beta", addedAt: 1, lastUsedAt: 1 }];
    setup();

    expect(await screen.findByText("beta")).toBeInTheDocument();
  });

  it("empty state hint renders when nothing is bookmarked", async () => {
    setup();
    expect(await screen.findByText(/按 ⌘O 添加项目目录/)).toBeInTheDocument();
  });
});

describe("thread interactions", () => {
  it("clicking a live thread activates its tab", async () => {
    const user = userEvent.setup();
    mockHistory.value = [];
    installTab({ id: "tab-live" });
    const { props } = setup();

    await user.click(screen.getByText("Live thread"));

    expect(useSessionStore.getState().activeSessionId).toBe("tab-live");
    expect(props.onResumeThread).not.toHaveBeenCalled();
  });

  it("clicking a persisted thread resumes it", async () => {
    const user = userEvent.setup();
    mockHistory.value = HISTORY;
    const { props } = setup();

    await user.click(await screen.findByText("Old thread"));

    expect(props.onResumeThread).toHaveBeenCalledTimes(1);
    expect(props.onResumeThread.mock.calls[0][0].id).toBe("acp-1");
  });

  it("the project + button starts a new session in that directory", async () => {
    const user = userEvent.setup();
    mockHistory.value = HISTORY;
    const { props } = setup();

    const group = (await screen.findByText("alpha")).closest("div.group");
    expect(group).toBeTruthy();
    const plus = group!.querySelector('button[title="在此项目中新建会话"]');
    expect(plus).toBeTruthy();
    await user.click(plus!);

    expect(props.onNewSessionInDir).toHaveBeenCalledWith("/w/alpha");
  });

  it("pinning a thread moves it to the 置顶 section and persists to localStorage", async () => {
    const user = userEvent.setup();
    mockHistory.value = HISTORY;
    setup();

    const entry = await screen.findByText("Old thread");
    await user.pointer({
      target: entry.closest("div") as HTMLElement,
      keys: "[MouseRight]",
    });
    await user.click(await screen.findByText("置顶"));

    await waitFor(() => {
      const pinned = JSON.parse(localStorage.getItem("gb-pinned-sessions")!) as string[];
      expect(pinned).toContain("hist-acp-1");
    });
    expect(screen.getByText("置顶")).toBeInTheDocument();
    expect(screen.getByText("Old thread")).toBeInTheDocument();
  });
});

describe("status indicators", () => {
  it("shows the running dot for a streaming tab and the waiting dot for a pending approval", async () => {
    mockHistory.value = [];
    installTab();
    useSessionStore.getState().setSessionStreaming("tab-live", true);
    setup();

    await screen.findByText("Live thread");
    expect(document.querySelector('span[title="运行中"]')).toBeTruthy();

    // Waiting state takes precedence visually — flip streaming off, add a card
    useSessionStore.getState().setSessionStreaming("tab-live", false);
    useSessionStore.getState().addPendingPermission("tab-live", {
      requestId: "r",
      toolName: "bash",
      command: "x",
      options: [],
    });

    await waitFor(() =>
      expect(document.querySelector('span[title="等待审批"]')).toBeTruthy()
    );
    expect(document.querySelector('span[title="运行中"]')).toBeNull();
  });
});

describe("project callbacks", () => {
  it("exposes the project menu with a per-project remove action", async () => {
    const user = userEvent.setup();
    mockProjects.value = [{ path: "/w/beta", addedAt: 1, lastUsedAt: 1 }];
    setup();

    const group = (await screen.findByText("beta")).closest("div.group");
    const menuBtn = group!.querySelector('button[title="项目操作"]');
    await user.click(menuBtn!);

    await user.click(await screen.findByText("Remove from sidebar"));
    const { removeProject } = await import("../../../lib/tauri");
    expect(removeProject).toHaveBeenCalledWith("/w/beta");
  });
});
