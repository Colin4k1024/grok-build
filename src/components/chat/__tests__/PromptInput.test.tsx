import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptInput } from "../PromptInput";

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/tauri")>();
  return {
    ...actual,
    listRepoFiles: vi.fn(async () => ["src/main.ts", "src/util.ts", "docs/guide.md"]),
    listSkills: vi.fn(async () => [
      { name: "review", description: "Review the current diff" },
      { name: "release", description: "Cut a release" },
    ]),
  };
});

vi.mock("../../../hooks/useVoiceInput", () => ({
  useVoiceInput: (_onTranscript: (t: string) => void) => ({
    isRecording: false,
    interimText: "",
    toggleRecording: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    language: "auto" as const,
    setLanguage: vi.fn(),
  }),
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

function setup(overrides: Partial<Parameters<typeof PromptInput>[0]> = {}) {
  const props = {
    onSend: vi.fn(),
    onCancel: vi.fn(),
    isStreaming: false,
    ...overrides,
  };
  render(<PromptInput {...props} />);
  return props;
}

const IDLE_PLACEHOLDER = /发送消息/;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sending", () => {
  it("Enter sends the trimmed text and clears the composer", async () => {
    const user = userEvent.setup();
    const props = setup();

    const ta = screen.getByPlaceholderText(IDLE_PLACEHOLDER);
    await user.type(ta, "  hello world  {enter}");

    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith("hello world", []);
    expect(ta).toHaveValue("");
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    const user = userEvent.setup();
    const props = setup();

    const ta = screen.getByPlaceholderText(IDLE_PLACEHOLDER);
    await user.type(ta, "line1{shift>}{enter}{/shift}line2");

    expect(props.onSend).not.toHaveBeenCalled();
    expect(ta).toHaveValue("line1\nline2");
  });

  it("Cmd/Ctrl+Enter sends even mid-line", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.type(screen.getByPlaceholderText(IDLE_PLACEHOLDER), "go{meta>}{enter}{/meta}");

    expect(props.onSend).toHaveBeenCalledWith("go", []);
  });

  it("empty input never sends", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.type(screen.getByPlaceholderText(IDLE_PLACEHOLDER), "   {enter}");

    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("disabled composer ignores Enter", async () => {
    const user = userEvent.setup();
    const props = setup({ disabled: true });

    const ta = screen.getByPlaceholderText(IDLE_PLACEHOLDER);
    await user.type(ta, "hello{enter}");

    expect(props.onSend).not.toHaveBeenCalled();
  });
});

describe("streaming-time behavior", () => {
  it("Tab while streaming queues the prompt instead of sending", async () => {
    const user = userEvent.setup();
    const onQueue = vi.fn();
    setup({ isStreaming: true, onQueue });

    const ta = screen.getByPlaceholderText(/运行中/);
    await user.type(ta, "follow-up question{tab}");

    expect(onQueue).toHaveBeenCalledWith("follow-up question");
    expect(ta).toHaveValue("");
  });

  it("Tab while idle does not queue", async () => {
    const user = userEvent.setup();
    const onQueue = vi.fn();
    setup({ isStreaming: false, onQueue });

    await user.type(screen.getByPlaceholderText(IDLE_PLACEHOLDER), "plain{tab}");

    expect(onQueue).not.toHaveBeenCalled();
  });

  it("Escape while streaming cancels the turn", async () => {
    const user = userEvent.setup();
    const props = setup({ isStreaming: true });

    await user.type(screen.getByPlaceholderText(/运行中/), "{escape}");

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Enter while streaming still injects the message (codex mid-turn behavior)", async () => {
    const user = userEvent.setup();
    const props = setup({ isStreaming: true });

    await user.type(screen.getByPlaceholderText(/运行中/), "mid turn{enter}");

    expect(props.onSend).toHaveBeenCalledWith("mid turn", []);
  });
});

describe("input history recall", () => {
  it("Ctrl/Cmd+Up recalls the last sent prompt", async () => {
    const user = userEvent.setup();
    setup();

    const ta = screen.getByPlaceholderText(IDLE_PLACEHOLDER);
    await user.type(ta, "first{enter}");
    await user.type(ta, "second{enter}");
    // Bracket syntax carries held modifiers; the {arrowup} alias does not.
    await user.type(ta, "[ControlLeft>][ArrowUp][/ControlLeft]");

    expect(ta).toHaveValue("second");
    await user.type(ta, "[ControlLeft>][ArrowUp][/ControlLeft]");
    expect(ta).toHaveValue("first");
  });
});

describe("slash command menu", () => {
  it("typing '/' opens the menu filtered by the query", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(IDLE_PLACEHOLDER), "/comp");

    await waitFor(() => {
      expect(screen.getAllByText(/compact/).length).toBeGreaterThan(0);
    });
    // Non-matching commands stay hidden
    expect(screen.queryByText(/deep-research/)).toBeNull();
  });

  it("a space after the command closes the menu", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(IDLE_PLACEHOLDER), "/compact ");

    expect(screen.queryByText(/Compress conversation/)).toBeNull();
  });
});

describe("@ file and $ skill triggers", () => {
  it("typing '@' after text opens the file listbox and Enter accepts the pick", async () => {
    const user = userEvent.setup();
    setup({ cwd: "/w" });

    const ta = screen.getByPlaceholderText(IDLE_PLACEHOLDER);
    await user.type(ta, "read @ma");

    const box = await screen.findByRole("listbox");
    expect(box).toHaveTextContent("文件");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);

    await user.type(ta, "{enter}");
    expect(ta).toHaveValue("read @src/main.ts ");
  });

  it("typing '$' opens the skill listbox with descriptions", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(IDLE_PLACEHOLDER), "run $rev");

    const box = await screen.findByRole("listbox");
    expect(box).toHaveTextContent("技能");
    expect(box).toHaveTextContent("Review the current diff");
  });

  it("a space terminates the trigger query", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(IDLE_PLACEHOLDER), "email @ host");

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
