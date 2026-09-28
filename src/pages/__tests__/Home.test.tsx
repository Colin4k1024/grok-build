// @vitest-environment jsdom
/**
 * Home workbench tests (R4-04 #237): one primary composer, project
 * selection, and a WorkOverview that distinguishes live sessions from
 * resumable history WITHOUT duplicate entries.
 */
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type SessionTab } from "../../stores/sessionStore";

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    invoke: vi.fn(async () => undefined),
    listHistorySessions: vi.fn(async () => [
      {
        id: "acp-live", // SAME agent session as the live tab — must dedupe
        session_id: "s-1",
        title: "历史线程",
        cwd: "/repo",
        num_messages: 12,
        model: "m",
        last_active_at: "",
        created_at: Date.now() - 3600_000,
        updated_at: Date.now() - 1800_000,
      },
      {
        id: "acp-old",
        session_id: "s-2",
        title: "旧线程",
        cwd: "/other",
        num_messages: 4,
        model: "m",
        last_active_at: "",
        created_at: Date.now() - 7200_000,
        updated_at: Date.now() - 3600_000,
      },
    ]),
    pickDirectory: vi.fn(async () => null),
  };
});
vi.mock("../../components/chat/PromptInput", () => ({
  PromptInput: () => <div data-testid="home-composer" />,
}));

import { Home } from "../Home";

const liveTab: SessionTab = {
  id: "tab-1",
  acpSessionId: "acp-live",
  title: "活跃线程",
  cwd: "/repo",
  model: "m",
  reasoningEffort: "medium",
  createdAt: Date.now() - 5000,
  lastActiveAt: Date.now() - 1000,
};

function resetStore(tabs: SessionTab[] = []) {
  useSessionStore.setState({
    tabs,
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
    rateLimits: {},
  });
}

describe("Home (R4-04)", () => {
  beforeEach(() => resetStore());

  it("exposes exactly one primary composer and a project selector", async () => {
    render(
      <Home config={null} onStart={() => {}} onOpenSession={() => {}} onResumeThread={() => {}} creating={false} />,
    );
    expect(screen.getByTestId("home-composer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /选择目录|更改/ })).toBeInTheDocument();
  });

  it("work overview merges live and persisted recents WITHOUT duplicates", async () => {
    resetStore([liveTab]);
    render(
      <Home config={null} onStart={() => {}} onOpenSession={() => {}} onResumeThread={() => {}} creating={false} />,
    );
    // live tab wins over its history twin (same acpSessionId)
    const overview = await screen.findByTestId("work-overview");
    const entries = overview.querySelectorAll("[data-thread-entry]");
    expect(entries.length).toBe(2); // 活跃线程(live) + 旧线程(history), NOT 3
    expect(overview.textContent).toContain("活跃线程");
    expect(overview.textContent).toContain("旧线程");
    expect(overview.textContent).not.toContain("历史线程");
  });

  it("live entries are marked 进行中 / resumable entries are not", async () => {
    resetStore([liveTab]);
    render(
      <Home config={null} onStart={() => {}} onOpenSession={() => {}} onResumeThread={() => {}} creating={false} />,
    );
    const overview = await screen.findByTestId("work-overview");
    expect(overview.querySelector('[data-thread-entry][data-live="true"]')).not.toBeNull();
    expect(overview.querySelector('[data-thread-entry][data-live="false"]')).not.toBeNull();
  });

  it("shows an actionable empty state when there is no work at all", async () => {
    const tauri = await import("../../lib/tauri");
    (tauri.listHistorySessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    render(
      <Home config={null} onStart={() => {}} onOpenSession={() => {}} onResumeThread={() => {}} creating={false} />,
    );
    const overview = await screen.findByTestId("work-overview");
    expect(overview.textContent).toMatch(/开始新任务|暂无/);
  });

  it("running sessions show a TEXT 进行中 badge (never color alone)", async () => {
    resetStore([liveTab]);
    useSessionStore.setState({ streaming: { "tab-1": true } });
    render(
      <Home config={null} onStart={() => {}} onOpenSession={() => {}} onResumeThread={() => {}} creating={false} />,
    );
    const overview = await screen.findByTestId("work-overview");
    expect(overview.textContent).toContain("进行中");
    expect(overview.textContent).toContain("1 进行中"); // header count badge
  });

  it("pending approvals surface a 待处理 badge", async () => {
    resetStore([liveTab]);
    useSessionStore.setState({
      pendingPermissions: {
        "tab-1": [{ requestId: "r1", toolName: "bash", command: "rm -rf /tmp/x", options: [] } as never],
      },
    });
    render(
      <Home config={null} onStart={() => {}} onOpenSession={() => {}} onResumeThread={() => {}} creating={false} />,
    );
    const overview = await screen.findByTestId("work-overview");
    expect(overview.textContent).toContain("待处理");
  });

  it("empty threads (num_messages=0) are never offered as resumable", async () => {
    const tauri = await import("../../lib/tauri");
    (tauri.listHistorySessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "empty-1", session_id: "s-e", title: "空线程", cwd: "/x", num_messages: 0, model: "m", last_active_at: "", created_at: 1, updated_at: 2 },
    ]);
    render(
      <Home config={null} onStart={() => {}} onOpenSession={() => {}} onResumeThread={() => {}} creating={false} />,
    );
    const overview = await screen.findByTestId("work-overview");
    await waitFor(() => expect(overview.textContent).toMatch(/暂无/));
    expect(overview.textContent).not.toContain("空线程");
  });

  it("history load failure shows an error with a working retry", async () => {
    const tauri = await import("../../lib/tauri");
    const mock = tauri.listHistorySessions as ReturnType<typeof vi.fn>;
    mock.mockRejectedValueOnce(new Error("磁盘读取失败"));
    render(
      <Home config={null} onStart={() => {}} onOpenSession={() => {}} onResumeThread={() => {}} creating={false} />,
    );
    const overview = await screen.findByTestId("work-overview");
    await waitFor(() => expect(overview.textContent).toContain("历史加载失败"));
    mock.mockResolvedValueOnce([]);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(overview.textContent).toMatch(/暂无/));
  });

  it("refreshes when threads change elsewhere (gb-threads-changed)", async () => {
    const tauri = await import("../../lib/tauri");
    const mock = tauri.listHistorySessions as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue([]);
    render(
      <Home config={null} onStart={() => {}} onOpenSession={() => {}} onResumeThread={() => {}} creating={false} />,
    );
    await screen.findByTestId("work-overview");
    mock.mockResolvedValue([
      { id: "new-1", session_id: "s-n", title: "新线程", cwd: "/y", num_messages: 3, model: "m", last_active_at: "", created_at: 1, updated_at: 2 },
    ]);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("gb-threads-changed"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("work-overview").textContent).toContain("新线程"),
    );
  });
});
