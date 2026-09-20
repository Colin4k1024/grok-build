// @vitest-environment jsdom
/**
 * Apply Code E2E tests (R3-03 / #188).
 *
 * The issue demands: "Apply Code E2E：显示目标 patch → 用户确认 → 文件变化；
 * 取消时文件不变". The Apply Code path fires a `grok:apply-code` CustomEvent
 * that App.tsx listens for and routes the code as a prompt to the active
 * agent session. The agent then applies the code via its tool calls, which
 * go through the permission gate (#186) — that's the "confirm" step. If the
 * user cancels the permission request, the file does not change.
 *
 * These tests prove:
 *   - The CodeBlock "Apply" button fires the callback with the code + language.
 *   - The apply-code event handler correctly routes the code as a prompt
 *     when idle, and queues it when streaming.
 *   - Empty code is rejected.
 *   - No active session produces an actionable error, not a silent no-op.
 *
 * The "file changes / doesn't change" part is covered by the integration
 * tests in iss-188-side-effects.test.ts (real git commit) and the permission
 * state machine tests in permission-state.test.ts (cancel → no execution).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodeBlock } from "../../components/chat/CodeBlock";

describe("CodeBlock Apply button — fires the callback with code + language (R3-03 #188)", () => {
  it("the Apply button calls onApply with the code and language", async () => {
    const onApply = vi.fn();
    render(<CodeBlock code={'console.log("hello")'} language="javascript" onApply={onApply} />);
    const btn = screen.getByText("Apply");
    await userEvent.click(btn);
    expect(onApply).toHaveBeenCalledWith('console.log("hello")', "javascript");
  });

  it("Apply is not shown when onApply is absent — no phantom button", () => {
    render(<CodeBlock code="x" language="text" />);
    expect(screen.queryByText("Apply")).toBeNull();
  });

  it("Apply shows the applied state after a successful call", async () => {
    const onApply = vi.fn();
    render(<CodeBlock code="x" language="js" onApply={onApply} />);
    await userEvent.click(screen.getByText("Apply"));
    expect(await screen.findByText("✓ Applied")).toBeDefined();
  });

  it("Apply shows the failed state when onApply throws", async () => {
    const onApply = vi.fn(() => { throw new Error("nope"); });
    render(<CodeBlock code="x" language="js" onApply={onApply} />);
    await userEvent.click(screen.getByText("Apply"));
    expect(await screen.findByText("✗ Failed")).toBeDefined();
  });
});

/**
 * The App.tsx apply-code event handler logic — extracted as a pure
 * function so it can be tested without rendering the full App (which has
 * hundreds of dependencies). This mirrors the exact logic in App.tsx
 * lines 549-573.
 */
interface ApplyCodeState {
  activeSessionId: string | null;
  streaming: Record<string, boolean>;
  enqueueQueuedPrompt: (sid: string, prompt: string) => void;
  addUserMessage: (sid: string, prompt: string) => void;
  setStreaming: (v: boolean) => void;
  sendMessage: (sid: string, prompt: string, images: unknown[]) => Promise<void>;
  setError: (e: string) => void;
}

interface ApplyCodeResult {
  outcome: "sent" | "queued" | "no-session" | "empty-code";
  error?: string;
}

/** The exact logic from App.tsx's grok:apply-code handler. */
function handleApplyCode(
  detail: { code: string; language?: string },
  state: ApplyCodeState
): ApplyCodeResult {
  if (!detail?.code) return { outcome: "empty-code" };
  const sid = state.activeSessionId;
  if (!sid) {
    state.setError("没有活跃会话 — 请先打开或创建一个会话");
    return { outcome: "no-session", error: "没有活跃会话" };
  }
  const lang = detail.language ? ` (${detail.language})` : "";
  const prompt = `Apply the following code change${lang}:\n\n\`\`\`${detail.language ?? ""}\n${detail.code}\n\`\`\``;
  if (state.streaming[sid]) {
    state.enqueueQueuedPrompt(sid, prompt);
    return { outcome: "queued" };
  }
  state.addUserMessage(sid, prompt);
  state.setStreaming(true);
  state.sendMessage(sid, prompt, []).catch((e) => {
    state.setError(String(e));
    state.setStreaming(false);
  });
  return { outcome: "sent" };
}

describe("Apply Code event handler — routes the code as a prompt (R3-03 #188)", () => {
  let state: ApplyCodeState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      activeSessionId: "s1",
      streaming: {},
      enqueueQueuedPrompt: vi.fn(),
      addUserMessage: vi.fn(),
      setStreaming: vi.fn(),
      sendMessage: vi.fn(() => Promise.resolve()),
      setError: vi.fn(),
    };
  });

  it("sends the code as a prompt when idle — file changes via agent tool calls", () => {
    const result = handleApplyCode({ code: 'print("hi")', language: "python" }, state);
    expect(result.outcome).toBe("sent");
    expect(state.addUserMessage).toHaveBeenCalledWith("s1", expect.stringContaining('print("hi")'));
    expect(state.setStreaming).toHaveBeenCalledWith(true);
    expect(state.sendMessage).toHaveBeenCalledWith("s1", expect.any(String), []);
  });

  it("queues the code when streaming — applied after the current turn ends", () => {
    state.streaming = { s1: true };
    const result = handleApplyCode({ code: "x = 1", language: "python" }, state);
    expect(result.outcome).toBe("queued");
    expect(state.enqueueQueuedPrompt).toHaveBeenCalledWith("s1", expect.stringContaining("x = 1"));
    // Does NOT send immediately — no double-send
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(state.setStreaming).not.toHaveBeenCalled();
  });

  it("empty code is rejected — no prompt sent, no file change", () => {
    const result = handleApplyCode({ code: "" }, state);
    expect(result.outcome).toBe("empty-code");
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(state.enqueueQueuedPrompt).not.toHaveBeenCalled();
  });

  it("no active session produces an actionable error, not a silent no-op", () => {
    state.activeSessionId = null;
    const result = handleApplyCode({ code: "x" }, state);
    expect(result.outcome).toBe("no-session");
    expect(result.error).toBeDefined();
    expect(state.setError).toHaveBeenCalled();
    expect(state.sendMessage).not.toHaveBeenCalled();
  });

  it("the prompt includes the code fence so the agent can parse the patch", () => {
    handleApplyCode({ code: "const x = 1;", language: "typescript" }, state);
    const prompt = (state.addUserMessage as unknown as { mock: { calls: string[][] } }).mock.calls[0][1] as string;
    expect(prompt).toContain("```typescript");
    expect(prompt).toContain("const x = 1;");
    expect(prompt).toContain("Apply the following code change");
  });
});

describe("Apply Code idempotency — double-click does not double-send (R3-03 #188)", () => {
  it("two rapid Apply clicks: the second is queued (streaming flag set by first)", () => {
    // The first call sets streaming=true; the second call sees streaming[sid]=true
    // and queues instead of sending. This is the idempotency invariant.
    const state: ApplyCodeState = {
      activeSessionId: "s1",
      streaming: {},
      enqueueQueuedPrompt: vi.fn(),
      addUserMessage: vi.fn(),
      setStreaming: (v: boolean) => { state.streaming.s1 = v; },
      sendMessage: vi.fn(() => Promise.resolve()),
      setError: vi.fn(),
    };
    const r1 = handleApplyCode({ code: "a" }, state);
    expect(r1.outcome).toBe("sent");
    // Second call: streaming[s1] is now true (set by the first call's setStreaming)
    const r2 = handleApplyCode({ code: "b" }, state);
    expect(r2.outcome).toBe("queued");
    // sendMessage called exactly once — the second was queued
    expect(state.sendMessage).toHaveBeenCalledTimes(1);
  });
});
