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

  it("status text is static content (never animation-dependent)", () => {
    resetStore({ isStreaming: true });
    render(<PromptInput onSend={() => {}} onCancel={() => {}} isStreaming />);
    const status = screen.getByTestId("composer-status");
    expect(status.className).not.toMatch(/animate|gb-motion/);
    expect(status.textContent).toContain("运行中");
  });

  it("cancelling announces 停止中 until the cancel resolves", async () => {
    let resolveCancel: () => void = () => {};
    const onCancel = vi.fn(() => new Promise<void>((r) => { resolveCancel = r; }));
    resetStore({ isStreaming: true, activeSessionId: "s1" });
    render(<PromptInput onSend={() => {}} onCancel={onCancel} isStreaming />);
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByTestId("composer-status").textContent).toContain("停止中");
    expect(screen.getByRole("button", { name: "停止" })).toBeDisabled();
    resolveCancel!();
    await screen.findByText(/运行中/);
  });

  it("a synchronously-throwing onCancel never leaves the composer stuck in 停止中", async () => {
    const onCancel = vi.fn(() => {
      throw new Error("sync boom");
    });
    resetStore({ isStreaming: true, activeSessionId: "s1" });
    render(<PromptInput onSend={() => {}} onCancel={onCancel} isStreaming />);
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onCancel).toHaveBeenCalledOnce();
    // status recovers — the stop button is usable again
    await screen.findByText(/运行中/);
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
  });

  it("disabled with a reason announces the reason", () => {
    render(
      <PromptInput onSend={() => {}} onCancel={() => {}} isStreaming={false} disabled disabledReason="正在创建会话…" />,
    );
    expect(screen.getByTestId("composer-status").textContent).toContain("正在创建会话");
  });
});

describe("composer interaction (R4-04)", () => {
  it("Enter sends AND clears the composer", async () => {
    const onSend = vi.fn();
    render(<PromptInput onSend={onSend} onCancel={() => {}} isStreaming={false} />);
    const input = screen.getByPlaceholderText(/发送消息/);
    await userEvent.type(input, "你好");
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("你好", []);
    expect(input).toHaveValue("");
  });

  it("home variant renders the metadata controls (model / approval)", () => {
    render(
      <PromptInput
        onSend={() => {}}
        onCancel={() => {}}
        isStreaming={false}
        config={{ models: [{ id: "m1", name: "模型一" } as never], default_model: "m1" } as never}
        home={{
          cwd: "/proj",
          model: "m1",
          effort: "medium",
          approval: "ask",
          onCwdChange: () => {},
          onPatch: () => {},
        }}
      />,
    );
    // composer metadata row is present with model + approval controls
    expect(screen.getByText(/模型一|m1/)).toBeInTheDocument();
    expect(screen.getByTitle("审批模式")).toBeInTheDocument();
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
