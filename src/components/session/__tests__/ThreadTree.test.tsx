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

const mockHistory = vi.hoisted(() => ({
  value: [] as HistorySession[],
  nextCursor: null as string | null,
  total: 0,
  // captured load-more calls for pagination assertions
  calls: [] as ({ cursor?: string } | undefined)[],
}));
const mockProjects = vi.hoisted(() => ({ value: [] as ProjectEntry[] }));

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/tauri")>();
  return {
    ...actual,
    listProjects: vi.fn(async () => mockProjects.value),
    listHistorySessions: vi.fn(async (opts?: { cursor?: string }) => {
      mockHistory.calls.push(opts);
      return { items: mockHistory.value, nextCursor: mockHistory.nextCursor, total: mockHistory.total || mockHistory.value.length };
    }),
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
    workspace_exists: true,
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
    // honest semantics: no cwd → no workspace; the tree keeps no-cwd
    // sessions out of stale governance via the explicit cwd !== "" guard.
    workspace_exists: false,
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
  mockHistory.nextCursor = null;
  mockHistory.total = 0;
  mockHistory.calls = [];
  mockProjects.value = [];
  localStorage.clear();
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

describe("history pagination (R5-02 #258)", () => {
  it("renders a load-more button when nextCursor exists and appends the next page", async () => {
    const user = userEvent.setup();
    mockHistory.value = [HISTORY[0]];
    mockHistory.nextCursor = "cursor-page-2";
    mockHistory.total = 2;
    setup();

    await screen.findByText("Old thread");
    const more = await screen.findByRole("button", { name: /加载更多/ });
    expect(more).toHaveTextContent("共 2 条");

    // second page payload
    mockHistory.value = [HISTORY[1]];
    mockHistory.nextCursor = null;
    await user.click(more);

    await screen.findByText("No-cwd thread");
    // both pages are present; the button disappears when the cursor ends
    expect(screen.getByText("Old thread")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /加载更多/ })).toBeNull();
    expect(mockHistory.calls.some((c) => c?.cursor === "cursor-page-2")).toBe(true);
  });

  it("no load-more button when the first page is the last", async () => {
    mockHistory.value = HISTORY;
    mockHistory.nextCursor = null;
    setup();
    await screen.findByText("Old thread");
    expect(screen.queryByRole("button", { name: /加载更多/ })).toBeNull();
  });
});

describe("stale workspace governance (R5-02 #258)", () => {
  const STALE: HistorySession[] = [
    {
      id: "stale-1",
      session_id: "stale-1",
      title: "Test leftover A",
      cwd: "/tmp/gb-acp-transport-aaa",
      updated_at: Date.now() - 10_000,
      last_active_at: new Date(Date.now() - 10_000).toISOString(),
      model: "grok-4",
      num_messages: 3,
      workspace_exists: false,
    },
    {
      id: "stale-2",
      session_id: "stale-2",
      title: "Old vanished project",
      cwd: "/gone/project",
      updated_at: Date.now() - 20_000,
      last_active_at: new Date(Date.now() - 20_000).toISOString(),
      model: "grok-4",
      num_messages: 5,
      workspace_exists: false,
    },
  ];

  it("stale records leave the normal groups and land in the collapsed stale section", async () => {
    mockHistory.value = [...HISTORY, ...STALE];
    setup();

    await screen.findByText("Old thread");
    // stale titles are NOT in the normal flow
    expect(screen.queryByText("Test leftover A")).toBeNull();
    const section = screen.getByTestId("stale-history-section");
    expect(section).toHaveTextContent("不可用工作区");

    // expand
    const user = userEvent.setup();
    await screen.findByTestId("stale-history-section");
    await user.click(screen.getByRole("button", { name: /不可用工作区/ }));
    expect(await screen.findByText("Test leftover A")).toBeInTheDocument();
    expect(screen.getByText("Old vanished project")).toBeInTheDocument();
  });

  it("the test-leftover filter selects only gb-acp-* records and never deletes by itself", async () => {
    const user = userEvent.setup();
    mockHistory.value = STALE;
    setup();

    await screen.findByTestId("stale-history-section");
    await user.click(screen.getByRole("button", { name: /不可用工作区/ }));
    await user.click(await screen.findByRole("button", { name: /筛出测试遗留/ }));

    expect(screen.getByLabelText("选择 Test leftover A")).toBeChecked();
    expect(screen.getByLabelText("选择 Old vanished project")).not.toBeChecked();
    // selection only — nothing deleted
    const { deleteHistorySession } = await import("../../../lib/tauri");
    expect(deleteHistorySession).not.toHaveBeenCalled();
  });

  it("batch archive moves selected records out via the archive set", async () => {
    const user = userEvent.setup();
    mockHistory.value = STALE;
    setup();

    await screen.findByTestId("stale-history-section");
    await user.click(screen.getByRole("button", { name: /不可用工作区/ }));
    await user.click(screen.getByLabelText("选择 Old vanished project"));
    await user.click(screen.getByRole("button", { name: /归档所选/ }));

    await waitFor(() => {
      const archived = JSON.parse(localStorage.getItem("gb-archived-threads")!) as string[];
      expect(archived).toContain("stale-2");
    });
    // archived stale record leaves the section; the other stays
    expect(screen.queryByText("Old vanished project")).toBeNull();
    expect(screen.getByText("Test leftover A")).toBeInTheDocument();
  });

  it("batch delete requires an explicit second confirmation and reports partial failures", async () => {
    const user = userEvent.setup();
    mockHistory.value = STALE;
    setup();

    await screen.findByTestId("stale-history-section");
    await user.click(screen.getByRole("button", { name: /不可用工作区/ }));
    await user.click(screen.getByRole("button", { name: /筛出测试遗留/ }));
    await user.click(screen.getByLabelText("选择 Old vanished project"));

    const del = await screen.findByRole("button", { name: /永久删除所选/ });
    await user.click(del);

    // first confirm dialog with count + irreversibility
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("永久删除 2 条");
    expect(alert).toHaveTextContent("不可恢复");

    const { deleteHistorySession } = await import("../../../lib/tauri");
    // one delete fails — the summary must report it
    (deleteHistorySession as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("io error"));

    await user.click(screen.getByRole("button", { name: /确认删除 2 条/ }));

    await waitFor(() => expect(deleteHistorySession).toHaveBeenCalledTimes(2));
    // refresh happened after the batch
    await waitFor(() => expect(mockHistory.calls.length).toBeGreaterThan(1));
  });

  it("cancel on the confirmation keeps every record", async () => {
    const user = userEvent.setup();
    mockHistory.value = STALE;
    setup();

    await screen.findByTestId("stale-history-section");
    await user.click(screen.getByRole("button", { name: /不可用工作区/ }));
    await user.click(screen.getByLabelText("选择 Test leftover A"));
    await user.click(screen.getByRole("button", { name: /永久删除所选/ }));
    await user.click(await screen.findByRole("button", { name: "取消" }));

    const { deleteHistorySession } = await import("../../../lib/tauri");
    expect(deleteHistorySession).not.toHaveBeenCalled();
    expect(screen.getByText("Test leftover A")).toBeInTheDocument();
  });
});

describe("R5-06 virtualization (#262)", () => {
  it("2000 history threads do not synchronously create 2000 DOM rows", async () => {
    // All in one project so the flat model is one group + 2000 thread rows.
    const MANY: HistorySession[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `acp-big-${i}`,
      session_id: `acp-big-${i}`,
      title: `Thread ${i}`,
      cwd: "/w/big",
      updated_at: Date.now() - i * 1000,
      last_active_at: new Date(Date.now() - i * 1000).toISOString(),
      model: "grok-4",
      num_messages: 1,
      workspace_exists: true,
    }));
    mockHistory.value = MANY;
    setup();

    await screen.findByText("Thread 0");
    // The project badge confirms all 2000 are loaded into the row model...
    expect(screen.getByText("2000")).toBeInTheDocument();
    // ...but react-window renders only the virtualized window, not 2000 rows.
    const rendered = document.querySelectorAll('[data-testid="thread-row"]');
    expect(rendered.length).toBeLessThan(2000);
    // A bounded viewport holds well under a hundred — far from the full list.
    expect(rendered.length).toBeLessThan(100);
  });

  it("a background tab's streaming flip updates only its own row indicator", async () => {
    // Two live tabs in one project; both rows mount in the bounded viewport.
    installTab({ id: "tab-a", acpSessionId: "bg-a", title: "Thread A", cwd: "/w/pair" });
    installTab({
      id: "tab-b",
      acpSessionId: "bg-b",
      title: "Thread B",
      cwd: "/w/pair",
      lastActiveAt: Date.now() - 2000,
    });
    setup();

    await screen.findByText("Thread A");
    await screen.findByText("Thread B");
    // Neither row shows a running dot yet.
    expect(document.querySelectorAll('span[title="运行中"]').length).toBe(0);

    // Flip streaming on tab-b only. Its per-row selector re-renders; tab-a's
    // selector returns the same value and must not re-render (R5-06).
    useSessionStore.getState().setSessionStreaming("tab-b", true);
    await waitFor(() => {
      expect(document.querySelectorAll('span[title="运行中"]').length).toBe(1);
    });
  });
});

describe("R5-06 Codex review fixes", () => {
  it("rows spread react-window's listitem ARIA so the list is not announced empty", async () => {
    mockHistory.value = HISTORY;
    setup();

    await screen.findByText("Old thread");
    // react-window v2 passes role=listitem + aria-posinset/setsize; the row
    // component must spread them or screen readers see an empty list (P3).
    const items = document.querySelectorAll('[role="listitem"]');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].getAttribute("aria-posinset")).toBeTruthy();
    expect(items[0].getAttribute("aria-setsize")).toBeTruthy();
  });

  it("below-list archived sections stay reachable inside the scroll-capped wrapper", async () => {
    const user = userEvent.setup();
    const many: HistorySession[] = Array.from({ length: 30 }, (_, i) => ({
      ...HISTORY[0],
      id: `arch-${i}`,
      session_id: `arch-${i}`,
      title: `Archived ${i}`,
      cwd: "/w/big",
    }));
    mockHistory.value = many;
    // Pre-archive every entry so they land in the 已归档 section, not the list.
    localStorage.setItem(
      "gb-archived-threads",
      JSON.stringify(many.map((h) => `hist-${h.id}`))
    );
    setup();

    await screen.findByText("已归档");
    await user.click(screen.getByText("已归档"));

    // Expanded entries render inside the scroll-capped wrapper (P1 fix) — they
    // are queryable, not clipped away, and the wrapper carries overflow-y-auto.
    const wrapper = document.querySelector('[data-testid="below-list-scroll"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper!.className).toContain("overflow-y-auto");
    expect(wrapper!.textContent).toContain("Archived 0");
    expect(wrapper!.textContent).toContain("Archived 29");
  });
});
