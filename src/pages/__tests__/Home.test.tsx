// @vitest-environment jsdom
/**
 * Home workbench tests (R4-04 #237): one primary composer, project
 * selection, and a WorkOverview that distinguishes live sessions from
 * resumable history WITHOUT duplicate entries.
 */
import { render, screen } from "@testing-library/react";
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
});
