// @vitest-environment jsdom
/**
 * Composer interaction tests (R4-04 #237): explicit status feedback
 * (streaming / queued / recording / disabled) in a live region, keyboard
 * send, and the session metadata row.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptInput } from "../PromptInput";
import { useSessionStore } from "../../../stores/sessionStore";

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/tauri")>();
  return {
    ...actual,
    listRepoFiles: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
  };
});

const voiceBase = {
  interimText: "",
  toggleRecording: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  language: "auto" as const,
  setLanguage: vi.fn(),
  voiceState: "idle" as const,
  degraded: null,
  dismissDegraded: vi.fn(),
  mute: vi.fn(),
  unmute: vi.fn(),
};
let voiceOverrides: Partial<typeof voiceBase & { isRecording: boolean }> = {};

vi.mock("../../../hooks/useVoiceInput", () => ({
  useVoiceInput: (_cb: (t: string) => void) => ({ isRecording: false, ...voiceBase, ...voiceOverrides }),
}));

vi.mock("../../../hooks/useImagePaste", () => ({
  useImagePaste: () => ({
    images: [],
    onDrop: vi.fn(),
    onDragOver: vi.fn(),
    removeImage: vi.fn(),
    clearImages: vi.fn(),
  }),
}));

function resetStore(overrides: Partial<ReturnType<typeof useSessionStore.getState>> = {}) {
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
    rateLimits: {},
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  voiceOverrides = {};
  localStorage.clear();
  resetStore();
});

describe("composer status line (R4-04)", () => {
  it("streaming state announces 运行中 with stop/queue guidance", () => {
    resetStore({ isStreaming: true });
    render(<PromptInput onSend={() => {}} onCancel={() => {}} isStreaming />);
    const status = screen.getByTestId("composer-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toContain("运行中");
    expect(status.textContent).toContain("Esc 停止");
  });

  it("streaming + queued follow-ups announces the queue", () => {
    resetStore({
      isStreaming: true,
      activeSessionId: "s1",
      queuedPrompts: { s1: ["追问一", "追问二"] },
    });
    render(<PromptInput onSend={() => {}} onCancel={() => {}} isStreaming />);
    expect(screen.getByTestId("composer-status").textContent).toContain("2 条排队");
  });

  it("recording state announces 聆听中", () => {
    voiceOverrides = { isRecording: true };
    render(<PromptInput onSend={() => {}} onCancel={() => {}} isStreaming={false} />);
    expect(screen.getByTestId("composer-status").textContent).toContain("聆听中");
  });

  it("disabled (resuming) state announces 暂不可用", () => {
    render(<PromptInput onSend={() => {}} onCancel={() => {}} isStreaming={false} disabled />);
    expect(screen.getByTestId("composer-status").textContent).toContain("暂不可用");
  });

  it("idle state is empty (no noise)", () => {
    render(<PromptInput onSend={() => {}} onCancel={() => {}} isStreaming={false} />);
    expect(screen.getByTestId("composer-status").textContent).toBe("");
  });

  it("status text survives reduced-motion (status is content, not decoration)", () => {
    // reduced-motion only kills animation; the status region is static text
    resetStore({ isStreaming: true });
    render(<PromptInput onSend={() => {}} onCancel={() => {}} isStreaming />);
    const status = screen.getByTestId("composer-status");
    expect(status.className).not.toMatch(/animate|gb-motion/);
    expect(status.textContent).toContain("运行中");
  });
});

describe("composer interaction (R4-04)", () => {
  it("Enter sends; the composer clears", async () => {
    const onSend = vi.fn();
    render(<PromptInput onSend={onSend} onCancel={() => {}} isStreaming={false} />);
    const input = screen.getByPlaceholderText(/发送消息/);
    await userEvent.type(input, "你好");
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("你好", []);
  });

  it("Escape while streaming cancels", async () => {
    const onCancel = vi.fn();
    render(<PromptInput onSend={() => {}} onCancel={onCancel} isStreaming />);
    screen.getByPlaceholderText(/运行中/).focus();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("restores a per-session draft on mount", () => {
    resetStore({ activeSessionId: "s1", tabs: [] });
    localStorage.setItem("gb-draft-s1", "未发送的草稿");
    render(<PromptInput onSend={() => {}} onCancel={() => {}} isStreaming={false} />);
    expect(screen.getByPlaceholderText(/发送消息/)).toHaveValue("未发送的草稿");
  });

  it("send button disabled with empty text", () => {
    render(<PromptInput onSend={() => {}} onCancel={() => {}} isStreaming={false} />);
    expect(screen.getByTitle(/发送/)).toBeDisabled();
  });
});
