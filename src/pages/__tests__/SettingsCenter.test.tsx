// @vitest-environment jsdom
/**
 * Settings Center shell tests (R4-07 #240): grouped navigation, search,
 * scope awareness, source badges, staged change bar, unsaved-leave guard.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
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
    // group headers exist
    for (const g of ["工作区", "AI", "集成", "体验", "安全", "系统"]) {
      expect(nav.textContent).toContain(g);
    }
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
    await userEvent.click(screen.getByRole("button", { name: "外观" }));
    const badges = await screen.findAllByTestId("setting-source-badge");
    expect(badges.length).toBeGreaterThan(2);
    expect(badges.every((b) => b.dataset.source === "default")).toBe(true);
  });

  it("source badge shows 全局 after a global change", async () => {
    useSettingsStore.getState().setTheme("light");
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    await userEvent.click(screen.getByRole("button", { name: "外观" }));
    const badges = await screen.findAllByTestId("setting-source-badge");
    expect(badges.some((b) => b.dataset.source === "global")).toBe(true);
  });

  it("immediate settings write on change (theme)", async () => {
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    await userEvent.click(screen.getByRole("button", { name: "外观" }));
    await screen.findByTestId("setting-field-appearance.theme");
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

  it("project scope shows project override and project reset removes only the override", async () => {    useSessionStore.setState({
      tabs: [{
        id: "t1", acpSessionId: "a1", title: "T", cwd: "/proj/x", model: "m",
        reasoningEffort: "medium", createdAt: 1, lastActiveAt: 1,
      }],
      activeSessionId: "t1",
    });
    useSettingsStore.getState().setTheme("dark"); // global
    useSettingsStore.getState().setProjectOverride("/proj/x", "appearance.theme", "light");
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    await userEvent.click(screen.getByRole("button", { name: "外观" }));
    // switch to project scope
    await userEvent.click(screen.getByRole("radio", { name: /当前项目/ }));
    const badges = await screen.findAllByTestId("setting-source-badge");
    expect(badges.some((b) => b.dataset.source === "project")).toBe(true);
    // reset the project override from the field
    const field = screen.getByTestId("setting-field-appearance.theme");
    await userEvent.click(await within(field).findByRole("button", { name: "重置" }));
    // override gone; global untouched
    expect(useSettingsStore.getState().projectOverrides["/proj/x"]).toBeUndefined();
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  it("partial apply failure keeps other drafts and marks the failing field", async () => {
    render(<Settings />);
    await screen.findByRole("navigation", { name: "设置分类" });
    // stage sandboxMode on 权限
    await userEvent.click(screen.getByRole("button", { name: "权限" }));
    await userEvent.click(screen.getByRole("radio", { name: /完全访问/ }));
    // stage agentAutonomous on 代理 (sibling that should still apply)
    await userEvent.click(screen.getByRole("button", { name: "代理" }));
    await userEvent.click(screen.getByRole("button", { name: /高级/ }));
    await userEvent.click(await screen.findByRole("switch", { name: "自治执行" }));
    // force the sandbox write to fail
    const store = useSettingsStore.getState();
    const orig = store.setGlobalByKey;
    const spy = vi.spyOn(store, "setGlobalByKey").mockImplementation((key: string, value: unknown) => {
      if (key === "sandboxMode") throw new Error("模拟失败");
      return orig(key, value);
    });
    try {
      await userEvent.click(screen.getByRole("button", { name: "应用" }));
      const bar = await screen.findByTestId("settings-change-bar");
      expect(bar.textContent).toMatch(/保存失败/);
      // the sibling applied; the failed draft is kept
      expect(useSettingsStore.getState().agentAutonomous).toBe(true);
      expect(useSettingsStore.getState().sandboxMode).toBe("sandbox");
    } finally {
      spy.mockRestore();
    }
    // navigate back to 权限 — the failing field is marked there
    await userEvent.click(screen.getByRole("button", { name: "权限" }));
    const field = await screen.findByTestId("setting-field-permissions.sandboxMode");
    await waitFor(() =>
      expect(within(field).getByRole("alert").textContent).toContain("模拟失败"),
    );
    // cleanup for other tests
    useSettingsStore.getState().setAgentAutonomous(false);
  });

  it("leaving with staged edits triggers the unsaved guard", async () => {
    const { confirmLeaveIfDirty, setUnsavedGuard } = await import("../../lib/unsavedGuard");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<Settings />);
      await screen.findByRole("navigation", { name: "设置分类" });
      await userEvent.click(screen.getByRole("button", { name: "权限" }));
      await userEvent.click(screen.getByRole("radio", { name: /完全访问/ }));
      await screen.findByTestId("settings-change-bar");
      // guard is registered; confirmLeaveIfDirty consults it
      expect(confirmLeaveIfDirty()).toBe(false); // user declined
      expect(confirmSpy).toHaveBeenCalledOnce();
      confirmSpy.mockReturnValue(true);
      expect(confirmLeaveIfDirty()).toBe(true);
    } finally {
      confirmSpy.mockRestore();
      setUnsavedGuard(null);
    }
  });
});
