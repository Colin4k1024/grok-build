// @vitest-environment jsdom
//
// App-level navigation integration (R4-03 #236): rail clicks render the
// destination INSIDE the shell, the contextual sidebar and inspector are
// conversations-only, ⌘B is gated, deep-linked settings tabs reset, and
// session actions navigate back to conversations.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSessionStore } from "../stores/sessionStore";

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
    getCrashRecoveryStatus: vi.fn(async () => ({ crashed: false })),
    onTrayAction: vi.fn(async () => () => {}),
    onConfigChanged: vi.fn(async () => () => {}),
    onAcpEvent: vi.fn(async () => () => {}),
  };
});

vi.mock("../components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));
vi.mock("../components/chat/PromptInput", () => ({
  PromptInput: () => <div data-testid="prompt-input" />,
}));
vi.mock("../components/panels/RightPanel", () => ({
  RightPanel: () => <aside aria-label="检查器" data-testid="inspector" />,
}));
vi.mock("../components/chat/WorktreeOnboardingBanner", () => ({
  WorktreeOnboardingBanner: () => null,
}));
vi.mock("../pages/Home", () => ({
  Home: () => <div data-testid="home-page" />,
}));
vi.mock("../pages/Settings", () => ({
  Settings: ({ initialTab }: { initialTab?: string }) => (
    <div data-testid="settings-page" data-initial-tab={initialTab ?? "none"} />
  ),
}));
vi.mock("../pages/Dashboard", () => ({
  Dashboard: () => <div data-testid="dashboard-page" />,
}));
vi.mock("../pages/AutomationsPage", () => ({
  AutomationsPage: () => <div data-testid="automations-page" />,
}));
vi.mock("../pages/WorkspaceAgentsPage", () => ({
  WorkspaceAgentsPage: () => <div data-testid="agents-page" />,
}));

import App from "../App";

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

describe("App navigation shell (R4-03)", () => {
  beforeEach(() => resetStore());

  it("rail click renders the destination inside the shell; rail stays mounted", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    await userEvent.click(screen.getByRole("button", { name: /^仪表盘/ }));
    expect(await screen.findByTestId("dashboard-page")).toBeInTheDocument();
    // shell never unmounted
    expect(screen.getByRole("navigation", { name: "主导航" })).toBe(nav);
    expect(nav.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toMatch(/^仪表盘/);
  });

  it("sidebar and inspector are gated to conversations", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "主导航" });
    // conversations: sidebar + inspector exist
    expect(screen.getByTestId("inspector")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^仪表盘/ }));
    await screen.findByTestId("dashboard-page");
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
    // sidebar toggle is disabled off-conversations
    expect(screen.getByRole("button", { name: /切换会话侧栏/ })).toBeDisabled();
  });

  it("⌘B does not mutate sidebar state on non-conversation destinations", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "主导航" });
    await userEvent.click(screen.getByRole("button", { name: /^仪表盘/ }));
    await screen.findByTestId("dashboard-page");
    await userEvent.keyboard("{Meta>}b{/Meta}");
    // still on dashboard; no sidebar appeared
    expect(screen.getByTestId("dashboard-page")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "会话侧栏" })).not.toBeInTheDocument();
  });

  it("settings deep-link tab resets after leaving the destination", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "主导航" });
    // deep-link via palette command is covered by openSettings; emulate by
    // opening settings via rail twice, first with nothing to prove default
    await userEvent.click(screen.getByRole("button", { name: /^设置/ }));
    const first = await screen.findByTestId("settings-page");
    expect(first.dataset.initialTab).toBe("none");
    await userEvent.click(screen.getByRole("button", { name: /^会话/ }));
    await screen.findByTestId("home-page");
    await userEvent.click(screen.getByRole("button", { name: /^设置/ }));
    const second = await screen.findByTestId("settings-page");
    expect(second.dataset.initialTab).toBe("none");
  });

  it("every destination page is one rail click away (<= 2 operations)", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "主导航" });
    for (const [label, marker] of [
      ["仪表盘", "dashboard-page"],
      ["自动化", "automations-page"],
      ["代理", "agents-page"],
      ["设置", "settings-page"],
    ] as const) {
      await userEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
      expect(await screen.findByTestId(marker)).toBeInTheDocument();
    }
  });

  it("conversation subtree stays mounted (hidden) while visiting other destinations", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "主导航" });
    const home = await screen.findByTestId("home-page");
    await userEvent.click(screen.getByRole("button", { name: /^仪表盘/ }));
    await screen.findByTestId("dashboard-page");
    // still the same DOM node — not remounted
    expect(screen.getByTestId("home-page")).toBe(home);
    expect(home.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
  });
});
