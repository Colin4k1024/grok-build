// @vitest-environment jsdom
/**
 * Sandbox enforcement wiring (R4-07 #240): the settings store is the single
 * source of truth; every write path pushes to the main-process Policy.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type SessionTab } from "../../../stores/sessionStore";
import { useSettingsStore } from "../../../stores/settingsStore";

const setSessionApprovalMode = vi.fn(async (_id: string, _mode: string) => undefined);

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/tauri")>();
  return {
    ...actual,
    setSessionApprovalMode: (id: string, mode: "ask" | "full-access") =>
      setSessionApprovalMode(id, mode),
  };
});

import { SandboxToggle, setSandboxMode } from "../SandboxToggle";

const tab = (id: string, cwd: string): SessionTab => ({
  id,
  acpSessionId: id,
  title: id,
  cwd,
  model: "m",
  reasoningEffort: "medium",
  createdAt: 1,
  lastActiveAt: 1,
});

function reset() {
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
  setSessionApprovalMode.mockClear();
}

describe("SandboxToggle enforcement wiring", () => {
  beforeEach(reset);

  it("writes from ANY path push to the main-process Policy", async () => {
    useSessionStore.setState({ tabs: [tab("t1", "/p")] });
    render(<SandboxToggle />);
    // write via the STORE (as the settings field does), not the toggle
    useSettingsStore.getState().setSandboxMode("full");
    await screen.findByText("完全访问");
    expect(setSessionApprovalMode).toHaveBeenCalledWith("t1", "full-access");
    expect(useSessionStore.getState().tabs[0].approvalMode).toBe("full-access");
  });

  it("a session created AFTER the mode flipped is pushed on add", async () => {
    useSettingsStore.getState().setSandboxMode("full");
    render(<SandboxToggle />);
    // new tab arrives later
    useSessionStore.getState().addTab(tab("t2", "/p"));
    await screen.findByText("完全访问");
    expect(setSessionApprovalMode).toHaveBeenCalledWith("t2", "full-access");
  });

  it("a project override for sandboxMode resolves per tab's cwd", async () => {
    useSessionStore.setState({
      tabs: [tab("a", "/proj/a"), tab("b", "/proj/b")],
    });
    // global sandbox, but /proj/b is full-access
    useSettingsStore.getState().setProjectOverride("/proj/b", "permissions.sandboxMode", "full");
    render(<SandboxToggle />);
    await screen.findByText("Sandbox"); // global still sandbox
    expect(setSessionApprovalMode).toHaveBeenCalledWith("b", "full-access");
    expect(useSessionStore.getState().tabs.find((t) => t.id === "a")?.approvalMode ?? "ask").toBe("ask");
    expect(useSessionStore.getState().tabs.find((t) => t.id === "b")?.approvalMode).toBe("full-access");
  });

  it("toggle click writes the store (single source)", async () => {
    render(<SandboxToggle />);
    await screen.findByText("Sandbox");
    setSandboxMode("full"); // the non-React path
    await screen.findByText("完全访问");
    expect(useSettingsStore.getState().sandboxMode).toBe("full");
    expect(localStorage.getItem("gb-sandbox-mode")).toBe("full");
  });
});
