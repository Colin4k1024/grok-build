// @vitest-environment jsdom
/**
 * useTheme per-project resolution (R4-07 #240): the active project's
 * appearance.theme override wins over the global value while that project
 * is active — project scope is real, not display-only.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTheme } from "../useTheme";
import { useSessionStore, type SessionTab } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";

const tab = (id: string, cwd: string): SessionTab => ({
  id, acpSessionId: id, title: id, cwd, model: "m",
  reasoningEffort: "medium", createdAt: 1, lastActiveAt: 1,
});

describe("useTheme project resolution", () => {
  beforeEach(() => {
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
  });

  it("global theme applies when no project override exists", () => {
    useSessionStore.setState({ tabs: [tab("t1", "/p")], activeSessionId: "t1" });
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("dark");
  });

  it("the active project's override wins; switching projects re-resolves", () => {
    useSettingsStore.getState().setProjectOverride("/proj/a", "appearance.theme", "light");
    useSessionStore.setState({
      tabs: [tab("a", "/proj/a"), tab("b", "/proj/b")],
      activeSessionId: "a",
    });
    const { result, rerender } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("light");
    useSessionStore.getState().setActiveSession("b");
    rerender();
    expect(result.current.mode).toBe("dark");
  });

  it("an invalid project override is ignored (global wins, no crash)", () => {
    useSettingsStore.setState({
      projectOverrides: { "/p": { "appearance.theme": "banana" } },
    });
    useSessionStore.setState({ tabs: [tab("t", "/p")], activeSessionId: "t" });
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("dark");
  });
});
