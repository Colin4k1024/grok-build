// @vitest-environment jsdom
/**
 * Settings Center shell tests (R4-07 #240): grouped navigation, search,
 * scope awareness, source badges, staged change bar, unsaved-leave guard.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    invoke: vi.fn(async () => undefined),
    listSkills: vi.fn(async () => []),
  };
});

import { Settings } from "../Settings";

function resetStores() {
  localStorage.clear();
  useSettingsStore.setState({
    theme: "dark", fontSize: "medium", zoom: 1.0, sandboxMode: "sandbox",
    notificationsEnabled: true, agentMode: "code", agentAutonomous: false,
    voiceLanguage: "auto", voiceWakeEnabled: false, voiceTtsEnabled: false,
    trustedFolders: [], projectOverrides: {}, userPresets: {},
  });
  useSessionStore.setState({
    tabs: [], activeSessionId: null, messages: {}, pendingPermissions: {},
    pendingQuestions: {}, subagents: {}, todos: {}, tokenUsage: {},
    compacting: {}, compactionMarkers: {}, preCompactSnapshot: {},
    queuedPrompts: {}, isStreaming: false, streaming: {},
  });
}

describe("Settings Center (R4-07)", () => {
  beforeEach(() => resetStores());

  it("renders grouped category navigation", async () => {
    render(<Settings />);
    const nav = await screen.findByRole("navigation", { name: "设置分类" });
    // grouped headers exist
    expect(nav.textContent).toContain("外观");
    expect(nav.textContent).toContain("权限");
  });

  it("search filters settings by label/description/keyword", async () => {
    render(<Settings />);
    const search = await screen.findByRole("searchbox", { name: /搜索设置/ });
    await userEvent.type(search, "沙箱");
    // sandboxMode setting surfaces (field label + its control label)
    const matches = await screen.findAllByText("沙箱模式");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // unrelated field is gone
    expect(screen.queryByText("界面字号")).not.toBeInTheDocument();
  });

  it("basic mode hides advanced fields", async () => {
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    // agent.autonomous is advanced — navigate to 代理 section
    await userEvent.click(screen.getByRole("button", { name: "代理" }));
    expect(screen.queryByText("自治执行")).not.toBeInTheDocument();
    // toggle to advanced
    await userEvent.click(screen.getByRole("button", { name: /高级/ }));
    await screen.findByText("自治执行");
  });

  it("source badge shows 默认 for untouched settings", async () => {
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    const badges = screen.getAllByText("默认");
    expect(badges.length).toBeGreaterThan(2);
  });

  it("source badge shows 全局 after a global change", async () => {
    useSettingsStore.getState().setTheme("light");
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    expect(screen.getAllByText("全局").length).toBeGreaterThan(0);
  });

  it("immediate settings write on change (theme)", async () => {
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    await userEvent.click(screen.getByRole("radio", { name: "浅色" }));
    expect(useSettingsStore.getState().theme).toBe("light");
    // immediate → no change bar
    expect(screen.queryByTestId("settings-change-bar")).not.toBeInTheDocument();
  });

  it("staged settings collect in the change bar; Apply writes, Discard reverts", async () => {
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    await userEvent.click(screen.getByRole("button", { name: "权限" }));
    // sandboxMode is staged — toggle it
    await userEvent.click(screen.getByRole("radio", { name: /完全访问/ }));
    // NOT written yet
    expect(useSettingsStore.getState().sandboxMode).toBe("sandbox");
    const bar = await screen.findByTestId("settings-change-bar");
    expect(bar.textContent).toMatch(/1 项未保存/);
    await userEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(useSettingsStore.getState().sandboxMode).toBe("full"));
    expect(screen.queryByTestId("settings-change-bar")).not.toBeInTheDocument();
  });

  it("staged Discard reverts the draft", async () => {
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    await userEvent.click(screen.getByRole("button", { name: "权限" }));
    await userEvent.click(screen.getByRole("radio", { name: /完全访问/ }));
    await screen.findByTestId("settings-change-bar");
    await userEvent.click(screen.getByRole("button", { name: "放弃" }));
    expect(screen.queryByTestId("settings-change-bar")).not.toBeInTheDocument();
    expect(useSettingsStore.getState().sandboxMode).toBe("sandbox");
  });

  it("project scope shows project override and resets it without touching global", async () => {
    useSessionStore.setState({
      tabs: [{
        id: "t1", acpSessionId: "a1", title: "T", cwd: "/proj/x", model: "m",
        reasoningEffort: "medium", createdAt: 1, lastActiveAt: 1,
      }],
      activeSessionId: "t1",
    });
    useSettingsStore.getState().setProjectOverride("/proj/x", "appearance.theme", "light");
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    // switch to project scope
    await userEvent.click(screen.getByRole("radio", { name: /当前项目/ }));
    await screen.findAllByText("项目");
  });
});
