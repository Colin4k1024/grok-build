// @vitest-environment jsdom
/**
 * Cross-app accessibility interaction contract (R4-10 #243): focus
 * visibility, keyboard activation of every top-level destination, live
 * regions, reduced-motion policy, and dialog layer discipline.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../stores/sessionStore";

const css = readFileSync("src/styles.css", "utf-8");

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();
  return {
    ...actual,
    invoke: vi.fn(async () => undefined),
    getAuthStatus: vi.fn(async () => ({ authenticated: true, username: "t" })),
    getConfig: vi.fn(async () => ({
      models: [], default_model: "", web_search_model: "",
      image_description_model: "", session_summary_model: "",
    })),
    listSessions: vi.fn(async () => []),
    getCrashRecoveryStatus: vi.fn(async () => ({ crashed: false })),
    onTrayAction: vi.fn(async () => () => {}),
    onConfigChanged: vi.fn(async () => () => {}),
    onAcpEvent: vi.fn(async () => () => {}),
  };
});
vi.mock("../components/chat/MessageList", () => ({ MessageList: () => <div data-testid="message-list" /> }));
vi.mock("../components/chat/PromptInput", () => ({ PromptInput: () => <div data-testid="prompt-input" /> }));
vi.mock("../components/panels/RightPanel", () => ({ RightPanel: () => <aside aria-label="检查器" /> }));
vi.mock("../components/chat/WorktreeOnboardingBanner", () => ({ WorktreeOnboardingBanner: () => null }));
vi.mock("../pages/Home", () => ({ Home: () => <div data-testid="home-page" /> }));
vi.mock("../pages/Settings", () => ({ Settings: () => <div data-testid="settings-page" /> }));
vi.mock("../pages/Dashboard", () => ({ Dashboard: () => <div data-testid="dashboard-page" /> }));
vi.mock("../pages/AutomationsPage", () => ({ AutomationsPage: () => <div data-testid="automations-page" /> }));
vi.mock("../pages/WorkspaceAgentsPage", () => ({ WorkspaceAgentsPage: () => <div data-testid="agents-page" /> }));

import App from "../App";

function resetStore() {
  useSessionStore.setState({
    tabs: [], activeSessionId: null, messages: {}, pendingPermissions: {},
    pendingQuestions: {}, subagents: {}, todos: {}, tokenUsage: {},
    compacting: {}, compactionMarkers: {}, preCompactSnapshot: {},
    queuedPrompts: {}, isStreaming: false, streaming: {},
  });
}

describe("cross-app accessibility (R4-10)", () => {
  beforeEach(resetStore);

  it("every top-level destination is keyboard-activatable (Tab + Enter)", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    // every rail button is tabbable and activates on Enter
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    expect(buttons.length).toBeGreaterThanOrEqual(6); // 5 destinations + search + sidebar toggle
    for (const btn of buttons) {
      expect(btn.tabIndex).not.toBe(-1);
    }
    // Enter activates
    const dashBtn = screen.getByRole("button", { name: /^仪表盘/ });
    dashBtn.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByTestId("dashboard-page")).toBeInTheDocument();
  });

  it("focus moves to the workspace after destination navigation (focus-follows)", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "主导航" });
    await userEvent.click(screen.getByRole("button", { name: /^设置/ }));
    await screen.findByTestId("settings-page");
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("skip link exists and targets the workspace", async () => {
    render(<App />);
    const skip = await screen.findByRole("link", { name: /跳到工作区/ });
    expect(skip).toHaveAttribute("href", "#gb-workspace");
  });

  it("icon-only rail buttons all have accessible names", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    for (const btn of Array.from(nav.querySelectorAll("button"))) {
      expect(btn.getAttribute("aria-label")?.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("styles.css a11y contract (R4-10)", () => {
  it("a global :focus-visible ring exists", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("rgb(var(--gb-focus))");
  });

  it("the reduced-motion block zeroes every motion duration token", () => {
    const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
    for (const v of ["--gb-motion-fast", "--gb-motion-normal", "--gb-motion-deliberate", "--gb-motion-press"]) {
      expect(reduced).toContain(`${v}: 0ms`);
    }
  });

  it("no emoji as interface icons in the shell", () => {
    // the rail uses SVG icons only
    const activityBar = readFileSync("src/components/layout/ActivityBar.tsx", "utf-8");
    expect(activityBar).not.toMatch(/[\u{1F300}-\u{1FAFF}✻⚡🔒]/u);
  });
});
